const cloudinary = require('cloudinary').v2;
const { PlatformError, unavailable } = require('./errors');

/**
 * The Cloudinary calls the platform makes. Files never pass through the
 * backend: it signs each browser upload, checks the response the browser
 * hands back, and makes short-lived links to private files. Tests pass a fake
 * with the same methods (test/helpers/fakeStorage.js).
 *
 * `url` is `CLOUDINARY_URL`: cloudinary://<api_key>:<api_secret>@<cloud_name>.
 */

/** Private files are reached through download links that expire after this long. */
const LINK_TTL_SECONDS = 10 * 60;

/** Every combination an asset can be stored under, for deleting a prefix. */
const STORAGE_CLASSES = [
  { resourceType: 'image', type: 'authenticated' },
  { resourceType: 'image', type: 'upload' },
  { resourceType: 'raw', type: 'authenticated' },
  { resourceType: 'raw', type: 'upload' }
];

function parseCloudinaryUrl(url) {
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?]+)/.exec(url ?? '');
  if (!match) throw new Error('CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>');
  return { apiKey: decodeURIComponent(match[1]), apiSecret: decodeURIComponent(match[2]), cloudName: match[3] };
}

const storageNotConfigured = () => unavailable('storage_not_configured', 'Set CLOUDINARY_URL on the backend to store files');

/** A Cloudinary failure during an API request, as a 502. */
function storageApiError(error) {
  if (error instanceof PlatformError) return error;
  const message = error?.error?.message || error?.message || String(error);
  console.error('[storage]', message);
  return new PlatformError(`Cloudinary didn't complete the request: ${message}`, { status: 502, code: 'storage_unavailable' });
}

const unixTime = (date = new Date()) => Math.floor(date.getTime() / 1000);

/** Files the backend reads itself (photos for a PDF) are at most this big, and fetched within this long. */
const READ_LIMITS = { maxBytes: 20 * 1024 ** 2, timeoutMs: 15_000 };

/** GETs `url` into a buffer, refusing a response over `maxBytes` or slower than `timeoutMs`. */
async function fetchBytes(url, { maxBytes, timeoutMs } = READ_LIMITS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error(`Larger than ${maxBytes} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Larger than ${maxBytes} bytes`);
  return bytes;
}

function createStorageGateway({ url }) {
  if (!url) {
    const notConfigured = () => {
      throw storageNotConfigured();
    };
    return {
      configured: false,
      signUpload: notConfigured,
      verifyUpload: notConfigured,
      downloadUrl: notConfigured,
      readFile: notConfigured,
      publicUrl: notConfigured,
      deleteAsset: notConfigured,
      deletePrefix: notConfigured
    };
  }

  const { apiKey, apiSecret, cloudName } = parseCloudinaryUrl(url);
  // verify_api_response_signature reads the secret from the SDK's global config.
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

  return {
    configured: true,

    /**
     * The fields of one signed upload. The signature covers every field, so
     * the browser can't change the public ID, the delivery type or the
     * allowed formats. It's valid for an hour.
     */
    signUpload({ publicId, type, allowedFormats, format, transformation }) {
      const params = {
        public_id: publicId,
        type,
        allowed_formats: allowedFormats.join(','),
        timestamp: unixTime(),
        ...(format ? { format } : {}),
        ...(transformation ? { transformation } : {})
      };
      return {
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
        fields: { ...params, api_key: apiKey, signature: cloudinary.utils.api_sign_request(params, apiSecret) }
      };
    },

    /** Whether an upload response's signature is Cloudinary's, i.e. the file really was uploaded. */
    verifyUpload({ publicId, version, signature }) {
      return cloudinary.utils.verify_api_response_signature(publicId, version, signature);
    },

    /** A link to a private file that expires after `LINK_TTL_SECONDS`. */
    downloadUrl({ publicId, resourceType = 'image', format, type = 'authenticated', now = new Date() }) {
      return cloudinary.utils.private_download_url(publicId, format, {
        resource_type: resourceType,
        type,
        expires_at: unixTime(now) + LINK_TTL_SECONDS
      });
    },

    /** The bytes of a stored file, such as an inspection photo going into a PDF. Fails like fetchBytes. */
    async readFile({ publicId, resourceType = 'image', format, type = 'authenticated' }) {
      const url =
        type === 'upload'
          ? cloudinary.url(publicId, { secure: true, type, resource_type: resourceType, format, urlAnalytics: false })
          : cloudinary.utils.private_download_url(publicId, format, { resource_type: resourceType, type, expires_at: unixTime() + LINK_TTL_SECONDS });
      return fetchBytes(url);
    },

    /** The CDN link of a public (`upload`) image, such as a vehicle photo. It never expires. */
    publicUrl({ publicId, format }) {
      return cloudinary.url(publicId, { secure: true, type: 'upload', resource_type: 'image', format, urlAnalytics: false });
    },

    /** Deletes one asset. One that's already gone counts as deleted. */
    async deleteAsset({ publicId, resourceType = 'image', type = 'authenticated' }) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type, invalidate: true });
      } catch (error) {
        throw storageApiError(error);
      }
    },

    /** Deletes every asset whose public ID starts with `prefix`, e.g. `tenants/<id>/`. Safe to run again. */
    async deletePrefix(prefix) {
      try {
        for (const { resourceType, type } of STORAGE_CLASSES) {
          // Each call deletes up to 1,000 assets; `partial` means there are more.
          for (let partial = true; partial; ) {
            ({ partial } = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: resourceType, type }));
          }
        }
      } catch (error) {
        throw storageApiError(error);
      }
    }
  };
}

module.exports = { createStorageGateway, parseCloudinaryUrl, storageApiError, fetchBytes, LINK_TTL_SECONDS };

const crypto = require('node:crypto');
const { z } = require('zod');
const { conflict, forbidden, notFound } = require('../platform/errors');
const { iso, parse, can, moduleOn } = require('./common');

/**
 * Files of the tenant API: renter document scans, inspection photos, service
 * bills and vehicle photos, stored in Cloudinary (src/platform/storage.js)
 * under `tenants/<tenantId>/<folder>/<uuid>`.
 *
 * 1. The app asks for a signed upload of a kind (POST /uploads).
 * 2. The browser posts the file straight to Cloudinary with those fields.
 * 3. The app sends Cloudinary's response with the record (`fileInput`),
 *    which checks its signature and folder before the record keeps it.
 *
 * They're stored with the `authenticated` delivery type, so they're only
 * reached through the short-lived links `fileView` puts in responses. Kinds
 * marked `public` (vehicle photos, which the guest booking page shows) are
 * stored with `upload` and served from the CDN.
 */

const DOCUMENT_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
const PHOTO_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

/**
 * `permissions`: any of them lets a member upload the kind. Inspection
 * photos are stored as JPEGs at most 2000 px on a side, since private files
 * can't be resized on the way out; vehicle photos at most 1600 px.
 */
const FILE_KINDS = {
  document: { folder: 'documents', module: 'renters', permissions: ['renters:create', 'renters:update'], readPermission: 'renters:read', allowedFormats: DOCUMENT_FORMATS },
  inspection: {
    folder: 'inspections',
    module: 'rentals',
    permissions: ['rentals:checkin', 'rentals:return'],
    readPermission: 'rentals:read',
    allowedFormats: PHOTO_FORMATS,
    format: 'jpg',
    transformation: 'c_limit,h_2000,w_2000'
  },
  bill: { folder: 'bills', module: 'costs', permissions: ['costs:create'], readPermission: 'costs:read', allowedFormats: DOCUMENT_FORMATS },
  vehiclePhoto: {
    folder: 'vehicles',
    module: 'vehicles',
    permissions: ['vehicles:create', 'vehicles:update'],
    public: true,
    allowedFormats: PHOTO_FORMATS,
    format: 'jpg',
    transformation: 'c_limit,h_1600,w_1600'
  }
};

const deliveryType = (spec) => (spec.public ? 'upload' : 'authenticated');

const FILE_KIND_KEYS = Object.keys(FILE_KINDS);
const UPLOAD_PERMISSIONS = [...new Set(Object.values(FILE_KINDS).flatMap((kind) => kind.permissions))];

/** The tenant's logo is public: the guest booking page shows it. Super admins upload it from the config editor. */
const LOGO = { folder: 'branding', allowedFormats: ['jpg', 'jpeg', 'png', 'webp'], transformation: 'c_limit,h_512,w_512' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tenantPrefix = (tenantId) => `tenants/${tenantId}/`;
const newPublicId = (tenantId, folder) => `${tenantPrefix(tenantId)}${folder}/${crypto.randomUUID()}`;

/** The fields of a signed upload of `kind` for a tenant, with the public ID the file will get. */
function signFileUpload(storage, tenantId, kind) {
  const spec = FILE_KINDS[kind];
  const publicId = newPublicId(tenantId, spec.folder);
  return {
    kind,
    publicId,
    ...storage.signUpload({ publicId, type: deliveryType(spec), allowedFormats: spec.allowedFormats, format: spec.format, transformation: spec.transformation })
  };
}

function signLogoUpload(storage, tenantId) {
  const publicId = newPublicId(tenantId, LOGO.folder);
  return { kind: 'logo', publicId, ...storage.signUpload({ publicId, type: 'upload', allowedFormats: LOGO.allowedFormats, transformation: LOGO.transformation }) };
}

/** Refuses an upload once the tenant's files take up `limits.storageGb` (usage.storageGb, kept by refreshStorageUsage). */
async function assertStorageLeft({ Tenant, tenantId, limitGb }) {
  const tenant = await Tenant.findById(tenantId, { 'usage.storageGb': 1 }).lean();
  if ((tenant?.usage?.storageGb ?? 0) >= limitGb) {
    throw conflict(`Your plan's ${limitGb} GB of file storage is full. Remove files or ask for a higher limit.`);
  }
}

/**
 * A file the app uploaded for `kind`, as Cloudinary's upload response
 * describes it (`public_id` → `publicId`, and so on). The public ID must be
 * one this tenant's uploads get, and the response signature Cloudinary's.
 * Parses to what records store.
 */
function fileInput(ctx, kind) {
  const prefix = `${tenantPrefix(ctx.tenantId)}${FILE_KINDS[kind].folder}/`;
  return z
    .strictObject({
      publicId: z.string().refine((id) => id.startsWith(prefix) && UUID.test(id.slice(prefix.length)), { error: 'Not a file uploaded for this' }),
      version: z.number().int().positive(),
      signature: z.string().max(128),
      format: z.string().regex(/^[a-z0-9]{2,5}$/),
      bytes: z.number().int().min(0),
      resourceType: z.enum(['image', 'raw']).default('image')
    })
    .refine((file) => ctx.storage.verifyUpload(file), { error: "This upload couldn't be verified. Upload the file again." })
    .transform(({ publicId, resourceType, format, bytes }) => ({ publicId, resourceType, format, bytes, uploadedAt: new Date() }));
}

/**
 * A stored file as responses show it. `url` is a link that expires after a
 * few minutes, for callers with `permission`; it's null for the others.
 */
function fileView(ctx, file, permission) {
  if (!file?.publicId) return null;
  const url = ctx.storage?.configured && can(ctx, permission) ? ctx.storage.downloadUrl(file) : null;
  return { url, format: file.format, bytes: file.bytes, uploadedAt: iso(file.uploadedAt) };
}

/**
 * Deletes files of `kind` a record no longer has (replaced, or the record
 * was deleted). The record already changed, so a failure is only logged:
 * the file is left over, nothing is lost.
 */
async function discardFiles(ctx, files, kind) {
  const type = deliveryType(FILE_KINDS[kind]);
  for (const file of files) {
    if (!file?.publicId) continue;
    try {
      await ctx.storage.deleteAsset({ publicId: file.publicId, resourceType: file.resourceType, type });
    } catch (error) {
      console.error(`[storage] Couldn't delete ${file.publicId}: ${error.message}`);
    }
  }
}

const UploadRequestSchema = z.strictObject({ kind: z.enum(FILE_KIND_KEYS) });

/** POST /uploads: signs one browser upload, for a member who may write records of that kind. */
function createUploads({ platformDb }) {
  return {
    async signUpload(ctx, input) {
      const { kind } = parse(UploadRequestSchema, input);
      const spec = FILE_KINDS[kind];
      if (!moduleOn(ctx, spec.module)) throw notFound('Not found');
      if (!spec.permissions.some((permission) => can(ctx, permission))) {
        throw forbidden(`You don't have the ${spec.permissions.join(' or ')} permission`);
      }
      await assertStorageLeft({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, limitGb: ctx.config.limits.storageGb });
      return signFileUpload(ctx.storage, ctx.tenantId, kind);
    }
  };
}

module.exports = {
  FILE_KINDS,
  FILE_KIND_KEYS,
  UPLOAD_PERMISSIONS,
  tenantPrefix,
  signFileUpload,
  signLogoUpload,
  assertStorageLeft,
  fileInput,
  fileView,
  discardFiles,
  createUploads
};

const { fetchBytes } = require('../storage');
const { isEmbeddableImage } = require('./returnReceipt');

const LOGO_LIMITS = { maxBytes: 3 * 1024 ** 2, timeoutMs: 8_000 };

/**
 * Cloudinary converts an image to the format its URL's extension names, so
 * a logo on Cloudinary is asked for as a PNG: PDFs can embed PNG and JPEG,
 * not WebP or SVG.
 */
function embeddableUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'res.cloudinary.com') parsed.pathname = `${parsed.pathname.replace(/\.[a-z0-9]+$/i, '')}.png`;
  return parsed.toString();
}

/**
 * The tenant's logo (`branding.logoUrl`, an https URL) as bytes a PDF can
 * embed, or null. A logo that can't be fetched leaves the document without one.
 */
async function fetchLogo(url) {
  if (!url) return null;
  try {
    const bytes = await fetchBytes(embeddableUrl(url), LOGO_LIMITS);
    return isEmbeddableImage(bytes) ? bytes : null;
  } catch (error) {
    console.error(`[documents] Couldn't fetch the logo ${url}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchLogo, embeddableUrl };

/**
 * The documents a tenant's app can issue, configured under `documents` in
 * the tenant config. Today that's the return receipt: the PDF bill a
 * completed rental downloads as, which confirms the vehicle came back
 * (src/platform/documents/returnReceipt.js).
 *
 * Its texts can name the rental with placeholders such as `{plateNumber}`,
 * filled in when the PDF is made. The admin dashboard lists them from
 * GET /api/platform/meta (`documentPlaceholders`).
 */
const RETURN_RECEIPT_PLACEHOLDERS = [
  { key: 'businessName', description: 'The business name (branding.displayName)' },
  { key: 'renterName', description: "The renter's full name" },
  { key: 'vehicle', description: 'Make and model, e.g. Toyota Aqua' },
  { key: 'plateNumber', description: "The vehicle's registration plate" },
  { key: 'rentalCode', description: 'The rental code, e.g. RNT-2026-0042' },
  { key: 'returnDate', description: 'The day the vehicle came back' }
];

const PLACEHOLDER_KEYS = new Set(RETURN_RECEIPT_PLACEHOLDERS.map((placeholder) => placeholder.key));
const PLACEHOLDER = /\{([^{}\s]*)\}/g;

/** The `{names}` in `text` that aren't placeholders. */
const unknownPlaceholders = (text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => !PLACEHOLDER_KEYS.has(name));

/** `text` with its placeholders replaced by `values`. */
const fillPlaceholders = (text, values) => text.replace(PLACEHOLDER, (match, name) => (PLACEHOLDER_KEYS.has(name) ? String(values[name] ?? '') : match));

const RETURN_RECEIPT_DEFAULTS = {
  title: 'Rental invoice & return receipt',
  returnStatement: 'This confirms that {renterName} returned the {vehicle} ({plateNumber}) on {returnDate}, and that rental {rentalCode} is complete.',
  footer: 'Thank you for renting with {businessName}.'
};

module.exports = { RETURN_RECEIPT_PLACEHOLDERS, RETURN_RECEIPT_DEFAULTS, unknownPlaceholders, fillPlaceholders };

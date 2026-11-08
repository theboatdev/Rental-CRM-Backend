const { renderReturnReceipt, receiptFilename, formattersFor, rentalDetails, renterDetails, listLabel, PAYMENT_TYPE_LABELS } = require('./returnReceipt');

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (date) => date.toISOString().slice(0, 10);

/** A sample value for a custom field, so the preview shows the tenant's own fields. */
function sampleValue(field, today) {
  switch (field.type) {
    case 'number':
      return field.min ?? field.max ?? 2;
    case 'date':
      return today;
    case 'boolean':
      return true;
    case 'select':
      return field.options.find((option) => option.active)?.key ?? '';
    case 'file':
      return { format: field.accept === 'images' ? 'jpg' : 'pdf' };
    default:
      return 'Sample text';
  }
}

/**
 * A completed sample rental for `config`: five days, paid in full with the
 * deposit refunded, inspected at every point. It uses the tenant's codes,
 * labels, inspection points, payment methods and custom fields; photos are
 * grey placeholders.
 */
function sampleReceipt(config, { now = new Date(), issuedBy = null } = {}) {
  const format = formattersFor(config.locale);
  const prefixes = config.rules.codePrefixes;
  const year = now.getUTCFullYear();
  const returnedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const startDate = isoDay(new Date(now.getTime() - 5 * DAY_MS));
  const endDate = isoDay(now);
  const depositAmount = config.rules.defaultDepositAmount;
  const dailyRate = depositAmount > 0 ? Math.max(1, Math.round(depositAmount / 2)) : 100;
  const totalAmount = dailyRate * 5;
  const advance = Math.round(totalAmount * 0.3);
  const method = config.lists.paymentMethods.find((item) => item.active)?.key ?? 'CASH';
  const points = config.modules.rentals.inspectionPoints;
  const customFields = Object.fromEntries(config.fields.rentals.custom.filter((field) => field.active).map((field) => [field.key, sampleValue(field, endDate)]));
  const inspection = (at, odometer, notes) => ({
    at,
    by: 'Sample staff member',
    odometer,
    points,
    notes,
    photos: points.map((point) => ({ point, image: null, placeholder: 'Sample photo' }))
  });
  const payment = (number, at, type, amount) => ({
    receiptNumber: `${type === 'ADVANCE' ? prefixes.advance : prefixes.receipt}-${year}-${String(number).padStart(4, '0')}`,
    paidAt: at,
    type: PAYMENT_TYPE_LABELS[type],
    method: listLabel(config, 'paymentMethods', method),
    reference: '',
    amount: type === 'REFUND' ? -amount : amount
  });
  const pickedUpAt = new Date(`${startDate}T09:00:00Z`);

  return {
    code: `${prefixes.rental}-${year}-0042`,
    bookingCode: `${prefixes.booking}-${year}-0042`,
    source: 'COUNTER',
    renter: {
      fullName: 'Sample Renter',
      profileId: `${prefixes.renter}-0146`,
      phone: config.branding.supportPhone ?? '+94 77 123 4567',
      details: renterDetails(config, { email: 'renter@example.com', address: '12 Sample Road', country: 'Sri Lanka' })
    },
    vehicle: { plateNumber: 'CAB-4321', make: 'Toyota', model: 'Aqua', year: 2021 },
    startDate,
    endDate,
    returnedAt,
    totalDays: 5,
    dailyRate,
    totalAmount,
    depositAmount,
    paidAmount: totalAmount,
    depositRefunded: depositAmount > 0,
    fullPayment: { at: pickedUpAt, by: 'Sample staff member' },
    startMileage: 45_210,
    endMileage: 45_830,
    details: rentalDetails(config, { customFields, notes: 'Sample notes: airport drop-off, child seat.' }, format),
    inspections: [
      { title: 'Pickup inspection', record: inspection(pickedUpAt, 45_210, '') },
      { title: 'Return inspection', record: inspection(returnedAt, 45_830, 'Returned clean, fuel full.') }
    ],
    payments: [
      payment(43, new Date(pickedUpAt.getTime() - 3 * DAY_MS), 'ADVANCE', advance),
      payment(91, pickedUpAt, 'RENTAL', totalAmount - advance),
      ...(depositAmount > 0 ? [payment(92, pickedUpAt, 'DEPOSIT', depositAmount), payment(97, returnedAt, 'REFUND', depositAmount)] : [])
    ],
    issuedBy,
    issuedAt: now
  };
}

/** The return receipt of a sample rental, for previewing a config. */
async function previewReturnReceipt(config, { issuedBy = null, logo = null } = {}) {
  const receipt = sampleReceipt(config, { issuedBy });
  return { filename: `preview-${receiptFilename(receipt.code)}`, contentType: 'application/pdf', body: await renderReturnReceipt({ config, receipt, logo }) };
}

module.exports = { sampleReceipt, previewReturnReceipt };

/**
 * Response fields that reveal profit or margins. The tenant API drops them
 * from every response unless the caller has `financials:view`, so handlers
 * that return such figures must use these names. Raw amounts a role works
 * with (a rental's total, a cost entry's amount) aren't in the list — unless
 * `modules.rentals.hideBookingPricingWithoutFinancials` is on, in which case
 * BOOKING_PRICING_FIELDS are stripped too.
 */
const FINANCIAL_FIELDS = new Set([
  'revenue',
  'totalRevenue',
  'operatingCosts',
  'supplierCosts',
  'profit',
  'grossProfit',
  'netProfit',
  'margin',
  'profitMargin',
  'roi'
]);

/**
 * Booking / vehicle rate fields and outstanding balance. Stripped only when
 * the tenant turns on `modules.rentals.hideBookingPricingWithoutFinancials`
 * and the caller lacks `financials:view`. Payment ledger amounts (`amount`,
 * `paidAmount`) stay visible so staff can still collect money.
 */
const BOOKING_PRICING_FIELDS = new Set([
  'dailyRate',
  'secondaryDailyRate',
  'totalAmount',
  'depositAmount',
  'supplierRentalCost',
  'billableDays',
  'balance'
]);

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A copy of `value` without the given field names at any depth. Leaves dates, ids and other class instances as they are. */
function stripFields(value, keys) {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, keys));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keys.has(key))
      .map(([key, field]) => [key, stripFields(field, keys)])
  );
}

/** A copy of `value` without FINANCIAL_FIELDS at any depth. */
function stripFinancialFields(value) {
  return stripFields(value, FINANCIAL_FIELDS);
}

/**
 * Strips profit/margin fields, and when `hideBookingPricing` is true also
 * booking rate/total/deposit/supplier-cost and outstanding balance fields.
 */
function stripFinancialFieldsForCaller(value, { hideBookingPricing = false } = {}) {
  const keys = hideBookingPricing ? new Set([...FINANCIAL_FIELDS, ...BOOKING_PRICING_FIELDS]) : FINANCIAL_FIELDS;
  return stripFields(value, keys);
}

module.exports = {
  FINANCIAL_FIELDS,
  BOOKING_PRICING_FIELDS,
  stripFinancialFields,
  stripFinancialFieldsForCaller
};

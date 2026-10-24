/**
 * Response fields that reveal profit or margins. The tenant API drops them
 * from every response unless the caller has `financials:view`, so handlers
 * that return such figures must use these names. Raw amounts a role works
 * with (a rental's total, a cost entry's amount) aren't in the list.
 */
const FINANCIAL_FIELDS = new Set([
  'revenue',
  'totalRevenue',
  'operatingCosts',
  'profit',
  'grossProfit',
  'netProfit',
  'margin',
  'profitMargin',
  'roi'
]);

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A copy of `value` without FINANCIAL_FIELDS at any depth. Leaves dates, ids and other class instances as they are. */
function stripFinancialFields(value) {
  if (Array.isArray(value)) return value.map(stripFinancialFields);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FINANCIAL_FIELDS.has(key))
      .map(([key, field]) => [key, stripFinancialFields(field)])
  );
}

module.exports = { FINANCIAL_FIELDS, stripFinancialFields };

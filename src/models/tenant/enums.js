/**
 * Fixed vocabularies of the tenant models, as uppercase keys the tenant app
 * shows with its own labels. Values that differ per tenant (document types,
 * payment methods, cost categories) are not here: records store the list key
 * from the tenant's config instead.
 */
const VEHICLE_STATUSES = ['AVAILABLE', 'RENTED', 'MAINTENANCE'];
const TRANSMISSIONS = ['AUTOMATIC', 'MANUAL'];
const FUEL_TYPES = ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC'];

/** Overdue isn't stored: it's an ACTIVE rental past its end date. */
const RENTAL_STATUSES = ['RESERVED', 'ACTIVE', 'COMPLETED', 'CANCELLED'];

/** How a renter or booking arrived: at the counter, or through the guest portal. */
const SOURCES = ['COUNTER', 'ONLINE'];

const PAYMENT_TYPES = ['ADVANCE', 'RENTAL', 'DEPOSIT', 'DEPOSIT_REFUND', 'DAMAGE', 'LATE_FEE'];

const MEMBER_STATUSES = ['active', 'removed'];

module.exports = {
  VEHICLE_STATUSES,
  TRANSMISSIONS,
  FUEL_TYPES,
  RENTAL_STATUSES,
  SOURCES,
  PAYMENT_TYPES,
  MEMBER_STATUSES
};

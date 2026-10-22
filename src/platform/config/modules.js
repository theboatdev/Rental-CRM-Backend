/**
 * Feature modules a tenant can switch on or off in its config.
 * `tab` modules can appear in the tenant app's navigation; the others
 * surface inside other screens (fuel logs) or outside the app (guest portal).
 */
const MODULES = {
  dashboard: {
    label: 'Dashboard',
    description: 'Fleet utilization, revenue, operating costs and per-vehicle profit.',
    tab: true,
    requires: []
  },
  vehicles: {
    label: 'Fleet Inventory',
    description: 'Vehicle master records, status lifecycle and audit history.',
    tab: true,
    requires: []
  },
  renters: {
    label: 'Client Profiles',
    description: 'Renter profiles, identity documents and compliance warnings.',
    tab: true,
    requires: []
  },
  rentals: {
    label: 'Rentals & Inspection',
    description: 'Rental contracts, check-in/return and pickup/drop photo inspections.',
    tab: true,
    requires: ['vehicles', 'renters']
  },
  calendar: {
    label: 'Booking Calendar',
    description: 'Fleet schedule matrix, early reservations and handover check-in.',
    tab: true,
    requires: ['rentals']
  },
  payments: {
    label: 'Payment Ledger',
    description: 'Receipts, advances, security deposits and refunds.',
    tab: true,
    requires: ['rentals']
  },
  costs: {
    label: 'Workshop Costs',
    description: 'Service bills, repairs, insurance and other operating costs.',
    tab: true,
    requires: ['vehicles']
  },
  fuelLogs: {
    label: 'Fuel Logs',
    description: 'Fuel fill-ups and burn per vehicle, counted in operating costs.',
    tab: false,
    requires: ['vehicles']
  },
  whatsappDigest: {
    label: 'WhatsApp Digest',
    description: 'Scheduled performance digest sent to management over WhatsApp.',
    tab: true,
    requires: ['vehicles']
  },
  guestPortal: {
    label: 'Guest Booking Portal',
    description: 'Public link where renters self-register and request reservations.',
    tab: false,
    requires: ['vehicles', 'renters', 'rentals']
  }
};

const MODULE_KEYS = Object.keys(MODULES);
const TAB_MODULE_KEYS = MODULE_KEYS.filter((key) => MODULES[key].tab);

module.exports = { MODULES, MODULE_KEYS, TAB_MODULE_KEYS };

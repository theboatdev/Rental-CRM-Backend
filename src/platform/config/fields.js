/**
 * The fields each kind of record has built in, in form order. A tenant's
 * config lists them under `fields.<section>.builtIn`, next to its custom
 * fields, to rename them, add help text and choose list columns.
 *
 * - `core` fields are ones the rules depend on (rates, dates, amounts): they
 *   are always on, required and shown in lists.
 * - Every other field can be turned off or made required. `required` and
 *   `showInList` here are the defaults, matching how the apps behaved before
 *   fields were configurable.
 * - `type` tells the editor and the apps how values look; built-in types
 *   can't be changed.
 * - `note` says what happens when the field is off.
 */
const BUILT_IN_FIELDS = {
  vehicles: [
    { key: 'plateNumber', label: 'Registration plate', type: 'text', core: true },
    { key: 'make', label: 'Make', type: 'text', core: true },
    { key: 'model', label: 'Model', type: 'text', core: true },
    { key: 'year', label: 'Year', type: 'number', required: true, showInList: true },
    { key: 'transmission', label: 'Transmission', type: 'select', showInList: true, note: 'Off: vehicles are recorded as automatic.' },
    { key: 'fuelType', label: 'Fuel', type: 'select', showInList: true, note: 'Off: vehicles are recorded as petrol.' },
    { key: 'dailyRate', label: 'Daily rate', type: 'money', core: true },
    {
      key: 'secondaryDailyRate',
      label: 'Daily rate (second currency)',
      type: 'money',
      showInList: true,
      secondaryCurrencyOnly: true,
      note: 'Only used when locale.secondaryCurrency is set.'
    },
    { key: 'depositAmount', label: 'Security deposit', type: 'money', showInList: true, note: 'Off: new vehicles take rules.defaultDepositAmount.' },
    { key: 'mileage', label: 'Odometer', type: 'distance', showInList: true, note: 'Off: readings still come from hand-overs and returns.' },
    { key: 'thumbnail', label: 'Photo', type: 'photo', showInList: true },
    { key: 'notes', label: 'Notes', type: 'longText' }
  ],
  renters: [
    { key: 'fullName', label: 'Full legal name', type: 'text', core: true },
    { key: 'phone', label: 'Phone / WhatsApp', type: 'text', core: true },
    { key: 'email', label: 'Email', type: 'text', showInList: true },
    { key: 'residentType', label: 'Renter type', type: 'select', showInList: true, note: 'Off: every renter is recorded as a resident.' },
    { key: 'country', label: 'Country', type: 'text', showInList: true },
    { key: 'address', label: 'Address', type: 'text' },
    { key: 'emergencyContact', label: 'Emergency contact', type: 'contact' },
    { key: 'documents', label: 'Identity documents', type: 'documents', core: true },
    { key: 'notes', label: 'Notes', type: 'longText' }
  ],
  rentals: [
    { key: 'renter', label: 'Renter', type: 'reference', core: true },
    { key: 'vehicle', label: 'Vehicle', type: 'reference', core: true },
    { key: 'startDate', label: 'Pickup date', type: 'date', core: true },
    { key: 'endDate', label: 'Return date', type: 'date', core: true },
    { key: 'dailyRate', label: 'Daily rate', type: 'money', showInList: true, note: "Off: bookings take the vehicle's rate." },
    { key: 'depositAmount', label: 'Security deposit', type: 'money', note: "Off: bookings take the vehicle's deposit." },
    { key: 'notes', label: 'Notes (flight, delivery, requests)', type: 'longText' }
  ],
  payments: [
    { key: 'type', label: 'Type', type: 'select', core: true },
    { key: 'method', label: 'Method', type: 'select', core: true },
    { key: 'amount', label: 'Amount', type: 'money', core: true },
    { key: 'transactionReference', label: 'Slip / transaction reference', type: 'text', showInList: true },
    { key: 'notes', label: 'Notes', type: 'longText' }
  ],
  costs: [
    { key: 'vehicle', label: 'Vehicle', type: 'reference', core: true },
    { key: 'title', label: 'What was done', type: 'text', core: true },
    { key: 'category', label: 'Category', type: 'select', core: true },
    { key: 'amount', label: 'Cost', type: 'money', core: true },
    { key: 'incurredAt', label: 'Date', type: 'date', showInList: true, note: 'Off: costs are dated the day they are logged.' },
    { key: 'odometer', label: 'Odometer', type: 'distance', note: "Readings above the vehicle's odometer move it forward." },
    { key: 'serviceCenter', label: 'Workshop / supplier', type: 'text', showInList: true },
    { key: 'invoiceNumber', label: 'Invoice number', type: 'text', showInList: true },
    { key: 'notes', label: 'Notes', type: 'longText' }
  ]
};

const FIELD_SECTIONS = Object.keys(BUILT_IN_FIELDS);

module.exports = { BUILT_IN_FIELDS, FIELD_SECTIONS };

const { iso, dateString, todayIn } = require('./common');
const { fileView } = require('./files');

/**
 * Response shapes for the tenant operations. Ids are strings, timestamps ISO
 * strings, calendar dates YYYY-MM-DD. `customFields` holds the values of the
 * config's custom fields by key (see fields.js). Files are `fileView`s, with
 * a short-lived link for callers who may read the record. The tenant app's
 * `contract.ts` mirrors these.
 */

const idOf = (value) => (value?._id ? String(value._id) : value ? String(value) : null);

const vehicleRef = (v) => (v?._id ? { id: String(v._id), plateNumber: v.plateNumber, make: v.make, model: v.model } : null);
const renterRef = (r) => (r?._id ? { id: String(r._id), profileId: r.profileId, fullName: r.fullName, phone: r.phone } : null);

const presentVehicle = (v) => ({
  id: String(v._id),
  plateNumber: v.plateNumber,
  make: v.make,
  model: v.model,
  year: v.year ?? null,
  transmission: v.transmission,
  fuelType: v.fuelType,
  dailyRate: v.dailyRate,
  secondaryDailyRate: v.secondaryDailyRate ?? null,
  depositAmount: v.depositAmount,
  mileage: v.mileage,
  status: v.status,
  thumbnail: v.thumbnail ?? null,
  notes: v.notes ?? '',
  customFields: v.customFields ?? {},
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt)
});

/**
 * What a renter is missing for the tenant's compliance rules: the document
 * types `lists.documentTypes` requires for their resident type, and for a
 * tourist one of `rules.touristPermitDocumentKeys` (a driving permit).
 */
function complianceOf(renter, config) {
  const held = new Set(renter.documents.map((d) => d.type));
  const missingDocuments = config.lists.documentTypes
    .filter((type) => type.active && type.requiredFor.includes(renter.residentType) && !held.has(type.key))
    .map((type) => type.key);
  const permitKeys = config.rules.touristPermitDocumentKeys;
  const needsPermit = renter.residentType === 'tourist' && permitKeys.length > 0 && !permitKeys.some((key) => held.has(key));
  const unverified = renter.documents.filter((d) => !d.verified).map((d) => d.type);
  return { ok: missingDocuments.length === 0 && !needsPermit, missingDocuments, needsPermit, unverified };
}

const presentDocument = (d, ctx) => ({
  id: String(d._id),
  type: d.type,
  number: d.number ?? null,
  file: fileView(ctx, d.file, 'renters:read'),
  verified: d.verified,
  verifiedBy: d.verifiedBy ?? null,
  verifiedAt: iso(d.verifiedAt),
  uploadedAt: iso(d.uploadedAt)
});

const presentRenter = (r, ctx, rentalsCount = 0) => ({
  id: String(r._id),
  profileId: r.profileId,
  fullName: r.fullName,
  phone: r.phone,
  email: r.email ?? null,
  residentType: r.residentType,
  country: r.country ?? null,
  address: r.address ?? null,
  emergencyContact: r.emergencyContact?.name ? { name: r.emergencyContact.name, phone: r.emergencyContact.phone ?? null, relation: r.emergencyContact.relation ?? null } : null,
  documents: r.documents.map((d) => presentDocument(d, ctx)),
  compliance: complianceOf(r, ctx.config),
  source: r.source,
  notes: r.notes ?? '',
  customFields: r.customFields ?? {},
  rentalsCount,
  createdAt: iso(r.createdAt)
});

/** `points` are the checked inspection points; `photos` the ones with a photo. */
const presentInspection = (i, ctx) =>
  i
    ? {
        at: iso(i.at),
        by: i.by ?? null,
        odometer: i.odometer ?? null,
        points: (i.photos ?? []).map((p) => p.point),
        photos: (i.photos ?? []).filter((p) => p.file?.publicId).map((p) => ({ point: p.point, file: fileView(ctx, p.file, 'rentals:read') })),
        notes: i.notes ?? ''
      }
    : null;

/** `today` (the tenant's date) decides whether an active rental is overdue. */
function presentRental(r, ctx) {
  const today = todayIn(ctx.timezone);
  const endDate = dateString(r.endDate);
  return {
    id: String(r._id),
    code: r.code,
    bookingCode: r.bookingCode ?? null,
    status: r.status,
    overdue: r.status === 'ACTIVE' && endDate < today,
    source: r.source,
    vehicle: vehicleRef(r.vehicle) ?? { id: idOf(r.vehicle) },
    renter: renterRef(r.renter) ?? { id: idOf(r.renter) },
    startDate: dateString(r.startDate),
    endDate,
    actualReturnDate: iso(r.actualReturnDate),
    totalDays: r.totalDays,
    dailyRate: r.dailyRate,
    totalAmount: r.totalAmount,
    depositAmount: r.depositAmount,
    paidAmount: r.paidAmount ?? 0,
    // What the renter still owes, counting the deposit.
    balance: r.totalAmount + r.depositAmount - (r.paidAmount ?? 0),
    depositRefunded: r.depositRefunded ?? false,
    startMileage: r.startMileage ?? null,
    endMileage: r.endMileage ?? null,
    distance: r.endMileage != null && r.startMileage != null ? r.endMileage - r.startMileage : null,
    pickupInspection: presentInspection(r.pickupInspection, ctx),
    dropInspection: presentInspection(r.dropInspection, ctx),
    cancelledAt: iso(r.cancelledAt),
    createdBy: r.createdBy ?? null,
    notes: r.notes ?? '',
    customFields: r.customFields ?? {},
    createdAt: iso(r.createdAt)
  };
}

const presentPayment = (p) => ({
  id: String(p._id),
  receiptNumber: p.receiptNumber,
  type: p.type,
  method: p.method,
  amount: p.amount,
  rental: p.rental?._id ? { id: String(p.rental._id), code: p.rental.code } : { id: idOf(p.rental) },
  renter: renterRef(p.renter) ?? { id: idOf(p.renter) },
  paidAt: iso(p.paidAt),
  receivedBy: p.receivedBy ?? null,
  transactionReference: p.transactionReference ?? null,
  notes: p.notes ?? '',
  customFields: p.customFields ?? {},
  voided: Boolean(p.voidedAt),
  voidedAt: iso(p.voidedAt),
  voidedBy: p.voidedBy ?? null,
  voidReason: p.voidReason ?? null
});

const presentCost = (c, ctx) => ({
  id: String(c._id),
  vehicle: vehicleRef(c.vehicle) ?? { id: idOf(c.vehicle) },
  category: c.category,
  title: c.title,
  amount: c.amount,
  incurredAt: dateString(c.incurredAt),
  serviceCenter: c.serviceCenter ?? null,
  invoiceNumber: c.invoiceNumber ?? null,
  bill: fileView(ctx, c.billFile, 'costs:read'),
  odometer: c.odometer ?? null,
  createdBy: c.createdBy ?? null,
  notes: c.notes ?? '',
  customFields: c.customFields ?? {},
  createdAt: iso(c.createdAt)
});

const presentFuelLog = (f) => ({
  id: String(f._id),
  vehicle: vehicleRef(f.vehicle) ?? { id: idOf(f.vehicle) },
  filledAt: dateString(f.filledAt),
  liters: f.liters,
  pricePerLiter: f.pricePerLiter ?? null,
  totalCost: f.totalCost,
  station: f.station ?? null,
  odometer: f.odometer ?? null,
  createdBy: f.createdBy ?? null,
  notes: f.notes ?? '',
  createdAt: iso(f.createdAt)
});

module.exports = {
  vehicleRef,
  renterRef,
  presentVehicle,
  presentRenter,
  presentDocument,
  presentRental,
  presentPayment,
  presentCost,
  presentFuelLog,
  complianceOf
};

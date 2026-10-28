const { z } = require('zod');
const { PlatformError, conflict, invalid } = require('../platform/errors');
const { zodIssues } = require('../platform/config/path');
const { refreshStorageUsage } = require('../platform/usage');
const { iso, parse, inTransaction, todayIn, dateString, DateStringSchema, IdSchema, activeListKey } = require('./common');
const { builtInRules, fieldsOf } = require('./fields');
const { fileInput, signFileUpload, assertStorageLeft } = require('./files');
const { insertRenter, RENTER_FIELDS } = require('./renters');
const { bookWithin, bookingDays, findOverlap } = require('./rentals');
const { recordAudit } = require('./audit');

/**
 * The guest booking portal behind /api/public/:slug (src/routes/public.js).
 * Renters register, upload their documents and book a vehicle without an
 * account. A booking is a RESERVED rental with `source: 'ONLINE'`, made by the
 * same rules as at the counter (`bookWithin`). Guests never get file links,
 * plates, or anything about other bookings.
 */

const GUEST = { id: 'guest-portal', name: 'Guest portal' };

/** The built-in renter fields the booking form asks for. Notes and custom fields are left for staff. */
const GUEST_RENTER_FIELDS = ['email', 'residentType', 'country', 'address', 'emergencyContact'];

/** What the portal's logic needs from a request: like `contextOf`, with the guest as the actor and no permissions. */
const publicContextOf = (req) => ({
  models: req.models,
  config: req.config,
  timezone: req.config.locale.timezone,
  tenantId: req.tenant.id,
  tenant: req.tenant,
  permissions: new Set(),
  storage: req.storage,
  actor: GUEST
});

function fieldSettings(config, section, keys) {
  const { builtIn } = fieldsOf(config, section);
  return Object.fromEntries(keys.map((key) => [key, { label: builtIn[key].label, helpText: builtIn[key].helpText, on: builtIn[key].active, required: builtIn[key].required }]));
}

const DatesSchema = z.strictObject({ startDate: DateStringSchema, endDate: DateStringSchema });

const GuestBookingSchema = (ctx) => {
  const { residentTypes } = ctx.config.modules.guestPortal;
  return z.strictObject({
    renter: z.strictObject({
      fullName: RENTER_FIELDS.fullName,
      phone: RENTER_FIELDS.phone,
      email: RENTER_FIELDS.email.optional(),
      residentType: z.enum(residentTypes).default(residentTypes[0]),
      country: RENTER_FIELDS.country.optional(),
      address: RENTER_FIELDS.address.optional(),
      emergencyContact: RENTER_FIELDS.emergencyContact.optional(),
      documents: z
        .array(z.strictObject({ type: activeListKey(ctx.config, 'documentTypes'), number: z.string().trim().min(1).max(60), file: fileInput(ctx, 'document').optional() }))
        .max(10)
        .default([])
    }),
    vehicleId: IdSchema,
    startDate: DateStringSchema,
    endDate: DateStringSchema,
    notes: z.string().trim().max(1000).default('')
  });
};

/**
 * Parses a booking with the tenant's field settings for what the form asks:
 * a field that's off is dropped, a required one needs a value.
 */
function parseBooking(ctx, input) {
  const raw = input ?? {};
  const renterInput = raw.renter && typeof raw.renter === 'object' ? raw.renter : {};
  const renterRules = builtInRules(ctx.config, 'renters', renterInput, { prefix: 'renter.' });
  const rentalRules = builtInRules(ctx.config, 'rentals', raw);
  const asked = new Set([...GUEST_RENTER_FIELDS.map((key) => `renter.${key}`), 'notes']);

  const result = GuestBookingSchema(ctx).safeParse(raw);
  const issues = result.success ? [] : zodIssues(result.error);
  for (const issue of [...renterRules.issues, ...rentalRules.issues]) {
    if (asked.has(issue.path) && !issues.some((other) => other.path === issue.path)) issues.push(issue);
  }
  if (issues.length) throw invalid('Check the highlighted fields', issues);

  const data = result.data;
  for (const key of renterRules.off) delete data.renter[key];
  if (rentalRules.off.includes('notes')) data.notes = '';
  return data;
}

/**
 * With `guestPortal.requireDocumentUpload`, every document comes with its
 * scan, and the ones the renter's type requires (`lists.documentTypes`) must be there.
 */
function assertDocuments(ctx, renter) {
  if (!ctx.config.modules.guestPortal.requireDocumentUpload) return;
  const issues = [];
  renter.documents.forEach((document, index) => {
    if (!document.file) issues.push({ path: `renter.documents[${index}].file`, message: 'Upload a scan or photo of this document' });
  });
  const provided = new Set(renter.documents.map((d) => d.type));
  const residentType = renter.residentType ?? 'local';
  for (const type of ctx.config.lists.documentTypes) {
    if (type.active && type.requiredFor.includes(residentType) && !provided.has(type.key)) {
      issues.push({ path: 'renter.documents', message: `Add your ${type.label}` });
    }
  }
  if (issues.length) throw invalid('Some documents are missing', issues);
}

const presentGuestVehicle = (v, totalDays) => ({
  id: String(v._id),
  make: v.make,
  model: v.model,
  year: v.year ?? null,
  transmission: v.transmission,
  fuelType: v.fuelType,
  dailyRate: v.dailyRate,
  depositAmount: v.depositAmount,
  totalAmount: v.dailyRate * totalDays,
  thumbnail: v.thumbnail ?? null
});

function createPortal({ platformDb }) {
  const { Tenant } = platformDb.models;

  return {
    /** What the booking page needs: branding, locale, the document types it asks for and how the form's fields are set up. */
    profile(ctx) {
      const { branding, locale, modules, lists, rules } = ctx.config;
      return {
        tenant: { name: ctx.tenant.name, slug: ctx.tenant.slug },
        branding: {
          displayName: branding.displayName,
          shortName: branding.shortName,
          tagline: branding.tagline,
          logoUrl: branding.logoUrl,
          primaryColor: branding.primaryColor,
          supportEmail: branding.supportEmail,
          supportPhone: branding.supportPhone,
          whatsappNumber: branding.whatsappNumber
        },
        locale: { country: locale.country, currency: locale.currency, timezone: locale.timezone, dateLocale: locale.dateLocale, distanceUnit: locale.distanceUnit },
        today: todayIn(ctx.timezone),
        minRentalDays: rules.minRentalDays,
        residentTypes: modules.guestPortal.residentTypes,
        requireDocumentUpload: modules.guestPortal.requireDocumentUpload,
        // Whether document scans can be uploaded at all (file storage is configured).
        uploads: Boolean(ctx.storage?.configured),
        documentTypes: lists.documentTypes.filter((d) => d.active).map(({ key, label, requiredFor }) => ({ key, label, requiredFor })),
        fields: { renter: fieldSettings(ctx.config, 'renters', GUEST_RENTER_FIELDS), rental: fieldSettings(ctx.config, 'rentals', ['notes']) }
      };
    },

    /** The vehicles free for the dates, cheapest first, with what the stay costs. */
    async vehicles(ctx, query) {
      const dates = parse(DatesSchema, query);
      const totalDays = bookingDays(ctx, dates);
      const vehicles = await ctx.models.Vehicle.find({ status: { $ne: 'MAINTENANCE' } }).sort({ dailyRate: 1, make: 1, model: 1 }).lean();
      const free = [];
      for (const vehicle of vehicles) {
        if (!(await findOverlap(ctx, { vehicleId: vehicle._id, ...dates }))) free.push(vehicle);
      }
      return { ...dates, totalDays, vehicles: free.map((v) => presentGuestVehicle(v, totalDays)) };
    },

    /** Signs the upload of a document scan. Guests can upload documents and nothing else. */
    async signUpload(ctx, input) {
      parse(z.strictObject({ kind: z.literal('document') }), input);
      await assertStorageLeft({ Tenant, tenantId: ctx.tenantId, limitGb: ctx.config.limits.storageGb });
      return signFileUpload(ctx.storage, ctx.tenantId, 'document');
    },

    /** Registers the renter and books the vehicle in one transaction, and returns the voucher. */
    async book(ctx, input) {
      const data = parseBooking(ctx, input);
      assertDocuments(ctx, data.renter);
      bookingDays(ctx, data);

      let booked;
      try {
        await inTransaction(ctx, async (session) => {
          const renter = await insertRenter(ctx, data.renter, { source: 'ONLINE', session });
          const { rental, vehicle } = await bookWithin(
            ctx,
            session,
            { vehicleId: data.vehicleId, renterId: renter._id, startDate: data.startDate, endDate: data.endDate, notes: data.notes },
            { source: 'ONLINE' }
          );
          booked = { renter, rental, vehicle };
        });
      } catch (error) {
        // The counter's conflicts name other bookings and plates.
        if (error instanceof PlatformError && error.status === 409) {
          throw conflict('That vehicle is no longer free for those dates. Pick other dates or another vehicle.');
        }
        throw error;
      }

      const { renter, rental, vehicle } = booked;
      if (renter.documents.some((d) => d.file)) await refreshStorageUsage({ Tenant, tenantId: ctx.tenantId, models: ctx.models });
      await recordAudit(ctx, { action: 'renter.created', entityType: 'renter', entityId: String(renter._id), summary: `${renter.fullName} (${renter.profileId}) registered on the booking page` });
      await recordAudit(ctx, {
        action: 'rental.reserved',
        entityType: 'rental',
        entityId: String(rental._id),
        summary: `Booked online: ${vehicle.plateNumber} for ${renter.fullName} as ${rental.code}, ${data.startDate} to ${data.endDate}`
      });

      return {
        bookingCode: rental.code,
        profileId: renter.profileId,
        fullName: renter.fullName,
        vehicle: { make: vehicle.make, model: vehicle.model, year: vehicle.year ?? null },
        startDate: dateString(rental.startDate),
        endDate: dateString(rental.endDate),
        totalDays: rental.totalDays,
        dailyRate: rental.dailyRate,
        totalAmount: rental.totalAmount,
        depositAmount: rental.depositAmount,
        documents: renter.documents.map((d) => ({ type: d.type, scanned: Boolean(d.file) })),
        createdAt: iso(rental.createdAt)
      };
    }
  };
}

module.exports = { createPortal, publicContextOf, GUEST };

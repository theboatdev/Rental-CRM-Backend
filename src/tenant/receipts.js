const { conflict, notFound } = require('../platform/errors');
const { DEFAULT_DOCUMENTS } = require('../platform/config/schema');
const {
  renderReturnReceipt,
  receiptFilename,
  formattersFor,
  renterDetails,
  rentalDetails,
  listLabel,
  PAYMENT_TYPE_LABELS
} = require('../platform/documents/returnReceipt');
const { fetchLogo } = require('../platform/documents/images');
const { findOr404, dateString, can, moduleOn } = require('./common');

/** Photos are fetched from storage this many at a time. */
const PHOTO_CONCURRENCY = 6;

/** `fn` over `items`, at most `limit` at a time, in order. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Documents the tenant app downloads. GET /rentals/:id/return-receipt is
 * the return receipt of a completed rental: the PDF bill for the renter
 * (src/platform/documents/returnReceipt.js), as `documents.returnReceipt`
 * sets it up. It holds what the rental's details show the caller, so the
 * payments only appear for members with payments:read.
 *
 * `loadLogo` fetches `branding.logoUrl`; tests pass a stand-in.
 */
function createReceipts({ loadLogo = fetchLogo } = {}) {
  /** The photos of an inspection with their bytes, or null for a photo storage can't give. */
  const photosOf = (ctx, inspection, withImages) =>
    mapLimited(
      (inspection?.photos ?? []).filter((photo) => photo.file?.publicId),
      PHOTO_CONCURRENCY,
      async ({ point, file }) => {
        if (!withImages) return { point, image: null };
        try {
          return { point, image: await ctx.storage.readFile({ ...file, type: 'authenticated' }) };
        } catch (error) {
          console.error(`[documents] Couldn't read ${file.publicId}: ${error.message}`);
          return { point, image: null };
        }
      }
    );

  const inspectionOf = async (ctx, title, inspection, withImages) => ({
    title,
    record: inspection && {
      at: inspection.at,
      by: inspection.by?.name ?? null,
      odometer: inspection.odometer ?? null,
      points: (inspection.photos ?? []).map((photo) => photo.point),
      notes: inspection.notes ?? '',
      photos: await photosOf(ctx, inspection, withImages)
    }
  });

  return {
    async returnReceipt(ctx, rentalId) {
      const { config } = ctx;
      const settings = (config.documents ?? DEFAULT_DOCUMENTS).returnReceipt;
      if (!settings.enabled) throw notFound('Return receipts are turned off for this workspace');

      const rental = await findOr404(ctx.models.Rental, rentalId, 'Rental', {
        populate: { vehicle: 'plateNumber make model year', renter: 'profileId fullName phone email address country' }
      });
      if (rental.status !== 'COMPLETED') {
        throw conflict(`${rental.code} hasn't been returned yet. The return receipt is ready once the return is recorded.`);
      }

      const format = formattersFor(config.locale);
      const withPayments = settings.showPayments && moduleOn(ctx, 'payments') && can(ctx, 'payments:read');
      const withImages = settings.showInspections && settings.showInspectionPhotos;
      const [payments, pickup, drop, logo] = await Promise.all([
        withPayments ? ctx.models.Payment.find({ rental: rental._id, voidedAt: null }).sort({ paidAt: 1 }).lean() : null,
        inspectionOf(ctx, 'Pickup inspection', rental.pickupInspection, withImages),
        inspectionOf(ctx, 'Return inspection', rental.dropInspection, withImages),
        loadLogo(config.branding.logoUrl)
      ]);

      const renter = rental.renter ?? {};
      const vehicle = rental.vehicle ?? {};
      const receipt = {
        code: rental.code,
        bookingCode: rental.bookingCode ?? null,
        source: rental.source,
        renter: { fullName: renter.fullName ?? '', profileId: renter.profileId ?? '', phone: renter.phone ?? '', details: renterDetails(config, renter) },
        vehicle: { plateNumber: vehicle.plateNumber ?? '', make: vehicle.make ?? '', model: vehicle.model ?? '', year: vehicle.year ?? null },
        startDate: dateString(rental.startDate),
        endDate: dateString(rental.endDate),
        returnedAt: rental.actualReturnDate ?? rental.dropInspection?.at ?? new Date(),
        totalDays: rental.totalDays,
        dailyRate: rental.dailyRate,
        totalAmount: rental.totalAmount,
        depositAmount: rental.depositAmount,
        paidAmount: rental.paidAmount ?? 0,
        depositRefunded: rental.depositRefunded ?? false,
        fullPayment: rental.fullPayment?.at ? { at: rental.fullPayment.at, by: rental.fullPayment.by?.name ?? null } : null,
        startMileage: rental.startMileage ?? null,
        endMileage: rental.endMileage ?? null,
        details: rentalDetails(config, rental, format),
        inspections: [pickup, drop],
        payments:
          payments &&
          payments.map((payment) => ({
            receiptNumber: payment.receiptNumber,
            paidAt: payment.paidAt,
            type: PAYMENT_TYPE_LABELS[payment.type] ?? payment.type,
            method: listLabel(config, 'paymentMethods', payment.method),
            reference: payment.transactionReference ?? '',
            amount: payment.type === 'REFUND' ? -payment.amount : payment.amount
          })),
        issuedBy: ctx.actor.name,
        issuedAt: new Date()
      };

      return { filename: receiptFilename(rental.code), contentType: 'application/pdf', body: await renderReturnReceipt({ config, receipt, logo }) };
    }
  };
}

module.exports = { createReceipts };

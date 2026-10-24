const { z } = require('zod');
const { RESIDENT_TYPES } = require('../platform/config/schema');
const { forbidden, notFound } = require('../platform/errors');
const { parse, findOr404, nextCode, IdSchema, activeListKey, can, moduleOn } = require('./common');
const { presentRenter, presentRental } = require('./presenters');
const { recordAudit } = require('./audit');

const DocumentInputSchema = (config) =>
  z.strictObject({
    type: activeListKey(config, 'documentTypes'),
    number: z.string().trim().min(1).max(60),
    // Marking a document verified on entry needs renters:documents:verify.
    verified: z.boolean().default(false)
  });

const RENTER_FIELDS = {
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(30),
  email: z.email().transform((email) => email.toLowerCase()).nullable(),
  residentType: z.enum(RESIDENT_TYPES),
  country: z.string().trim().max(60).nullable(),
  address: z.string().trim().max(300).nullable(),
  emergencyContact: z
    .strictObject({ name: z.string().trim().min(1).max(120), phone: z.string().trim().max(30).optional(), relation: z.string().trim().max(40).optional() })
    .nullable(),
  notes: z.string().trim().max(1000)
};

const RenterInputSchema = (config) =>
  z.strictObject({
    ...RENTER_FIELDS,
    email: RENTER_FIELDS.email.optional(),
    residentType: RENTER_FIELDS.residentType.default('local'),
    country: RENTER_FIELDS.country.optional(),
    address: RENTER_FIELDS.address.optional(),
    emergencyContact: RENTER_FIELDS.emergencyContact.optional(),
    notes: RENTER_FIELDS.notes.default(''),
    documents: z.array(DocumentInputSchema(config)).max(10).default([])
  });

const RenterUpdateSchema = z.strictObject(RENTER_FIELDS).partial();

/** Rentals that count towards a renter's history (not reservations or cancellations). */
const COUNTED = { status: { $in: ['ACTIVE', 'COMPLETED'] } };

/**
 * Renter profiles with identity documents. Document types are the config's
 * `lists.documentTypes` keys; each profile reports what it lacks for the
 * tenant's compliance rules (see presenters.complianceOf).
 */
function createRenters() {
  const assertCanVerify = (ctx, documents) => {
    if (documents.some((d) => d.verified) && !can(ctx, 'renters:documents:verify')) {
      throw forbidden("You don't have the renters:documents:verify permission");
    }
  };
  const withVerifier = (ctx, document) =>
    document.verified ? { ...document, verifiedBy: ctx.actor, verifiedAt: new Date() } : document;

  return {
    /** Newest first, each with its number of active and completed rentals. */
    async listRenters(ctx) {
      const [renters, counts] = await Promise.all([
        ctx.models.Renter.find().sort({ createdAt: -1 }).lean(),
        ctx.models.Rental.aggregate([{ $match: COUNTED }, { $group: { _id: '$renter', count: { $sum: 1 } } }])
      ]);
      const countOf = new Map(counts.map(({ _id, count }) => [String(_id), count]));
      return renters.map((r) => presentRenter(r, ctx.config, countOf.get(String(r._id)) ?? 0));
    },

    async getRenter(ctx, renterId) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const showRentals = can(ctx, 'rentals:read') && moduleOn(ctx, 'rentals');
      const rentals = showRentals
        ? await ctx.models.Rental.find({ renter: renter._id }).sort({ startDate: -1 }).populate('vehicle', 'plateNumber make model').lean()
        : null;
      const rentalsCount = await ctx.models.Rental.countDocuments({ renter: renter._id, ...COUNTED });
      return {
        ...presentRenter(renter, ctx.config, rentalsCount),
        rentals: rentals && rentals.map((r) => presentRental({ ...r, renter }, ctx))
      };
    },

    /** Gives the profile the next code with the `rules.codePrefixes.renter` prefix, e.g. SR-0146. */
    async createRenter(ctx, input, { source = 'COUNTER', session } = {}) {
      const data = parse(RenterInputSchema(ctx.config), input);
      assertCanVerify(ctx, data.documents);
      const profileId = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.renter, sequence: 'renter', session });
      const [renter] = await ctx.models.Renter.create(
        [{ ...data, profileId, source, documents: data.documents.map((d) => withVerifier(ctx, d)) }],
        { session }
      );
      await recordAudit(ctx, { action: 'renter.created', entityType: 'renter', entityId: String(renter._id), summary: `Registered ${renter.fullName} (${profileId})` });
      return presentRenter(renter.toObject(), ctx.config);
    },

    async updateRenter(ctx, renterId, input) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const changes = parse(RenterUpdateSchema, input);
      const updated = await ctx.models.Renter.findOneAndUpdate({ _id: renter._id }, { $set: changes }, { returnDocument: 'after' }).lean();
      await recordAudit(ctx, { action: 'renter.updated', entityType: 'renter', entityId: String(renter._id), summary: `Updated ${renter.fullName}: ${Object.keys(changes).join(', ')}` });
      return presentRenter(updated, ctx.config);
    },

    async addDocument(ctx, renterId, input) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const document = parse(DocumentInputSchema(ctx.config), input);
      assertCanVerify(ctx, [document]);
      const updated = await ctx.models.Renter.findOneAndUpdate(
        { _id: renter._id },
        { $push: { documents: withVerifier(ctx, document) } },
        { returnDocument: 'after', runValidators: true }
      ).lean();
      await recordAudit(ctx, { action: 'renter.document_added', entityType: 'renter', entityId: String(renter._id), summary: `Added a ${document.type} document to ${renter.fullName}` });
      return presentRenter(updated, ctx.config);
    },

    async verifyDocument(ctx, renterId, documentId) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const { success } = IdSchema.safeParse(documentId);
      const document = success && renter.documents.find((d) => String(d._id) === documentId);
      if (!document) throw notFound('Document not found');
      const updated = await ctx.models.Renter.findOneAndUpdate(
        { _id: renter._id, 'documents._id': document._id },
        { $set: { 'documents.$.verified': true, 'documents.$.verifiedBy': ctx.actor, 'documents.$.verifiedAt': new Date() } },
        { returnDocument: 'after' }
      ).lean();
      await recordAudit(ctx, { action: 'renter.document_verified', entityType: 'renter', entityId: String(renter._id), summary: `Verified ${renter.fullName}'s ${document.type}` });
      return presentRenter(updated, ctx.config);
    }
  };
}

module.exports = { createRenters };

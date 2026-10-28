const { z } = require('zod');
const { RESIDENT_TYPES } = require('../platform/config/schema');
const { forbidden, notFound } = require('../platform/errors');
const { parse, findOr404, nextCode, IdSchema, activeListKey, can, moduleOn } = require('./common');
const { presentRenter, presentRental } = require('./presenters');
const { recordAudit } = require('./audit');
const { parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields } = require('./fields');
const { fileInput, discardFiles } = require('./files');
const { refreshStorageUsage } = require('../platform/usage');

/** A document's type and number, with the scan the app uploaded (`file`, see files.js) when there is one. */
const DocumentInputSchema = (ctx) =>
  z.strictObject({
    type: activeListKey(ctx.config, 'documentTypes'),
    number: z.string().trim().min(1).max(60),
    file: fileInput(ctx, 'document').optional(),
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

const RenterInputSchema = (ctx) =>
  z.strictObject({
    ...RENTER_FIELDS,
    email: RENTER_FIELDS.email.optional(),
    residentType: RENTER_FIELDS.residentType.default('local'),
    country: RENTER_FIELDS.country.optional(),
    address: RENTER_FIELDS.address.optional(),
    emergencyContact: RENTER_FIELDS.emergencyContact.optional(),
    notes: RENTER_FIELDS.notes.default(''),
    documents: z.array(DocumentInputSchema(ctx)).max(10).default([]),
    customFields: customFieldsInput(ctx.config, 'renters')
  });

const RenterUpdateSchema = (config) =>
  z.strictObject(RENTER_FIELDS).partial().extend({ customFields: customFieldsInput(config, 'renters', { update: true }) });

const AttachFileSchema = (ctx) => z.strictObject({ file: fileInput(ctx, 'document') });

/** Rentals that count towards a renter's history (not reservations or cancellations). */
const COUNTED = { status: { $in: ['ACTIVE', 'COMPLETED'] } };

/**
 * Saves a parsed profile with the next code with the `rules.codePrefixes.renter`
 * prefix, e.g. SR-0146. The guest portal calls it inside its booking transaction.
 */
async function insertRenter(ctx, data, { source = 'COUNTER', session } = {}) {
  const profileId = await nextCode(ctx, { prefix: ctx.config.rules.codePrefixes.renter, sequence: 'renter', session });
  const [renter] = await ctx.models.Renter.create([{ ...data, profileId, source }], { session });
  return renter.toObject();
}

/**
 * Renter profiles with identity documents. Document types are the config's
 * `lists.documentTypes` keys; each profile reports what it lacks for the
 * tenant's compliance rules (see presenters.complianceOf).
 */
function createRenters({ platformDb }) {
  const refreshStorage = (ctx) => refreshStorageUsage({ Tenant: platformDb.models.Tenant, tenantId: ctx.tenantId, models: ctx.models });
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
      return renters.map((r) => presentRenter(r, ctx, countOf.get(String(r._id)) ?? 0));
    },

    async getRenter(ctx, renterId) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const showRentals = can(ctx, 'rentals:read') && moduleOn(ctx, 'rentals');
      const rentals = showRentals
        ? await ctx.models.Rental.find({ renter: renter._id }).sort({ startDate: -1 }).populate('vehicle', 'plateNumber make model').lean()
        : null;
      const rentalsCount = await ctx.models.Rental.countDocuments({ renter: renter._id, ...COUNTED });
      return {
        ...presentRenter(renter, ctx, rentalsCount),
        rentals: rentals && rentals.map((r) => presentRental({ ...r, renter }, ctx))
      };
    },

    async createRenter(ctx, input) {
      const data = parseRecord(RenterInputSchema(ctx), input, ctx.config, 'renters');
      assertCanVerify(ctx, data.documents);
      const renter = await insertRenter(ctx, { ...data, documents: data.documents.map((d) => withVerifier(ctx, d)) });
      if (data.documents.some((d) => d.file)) await refreshStorage(ctx);
      await recordAudit(ctx, { action: 'renter.created', entityType: 'renter', entityId: String(renter._id), summary: `Registered ${renter.fullName} (${renter.profileId})` });
      return presentRenter(renter, ctx);
    },

    async updateRenter(ctx, renterId, input) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const { customFields, ...changes } = parseRecord(RenterUpdateSchema(ctx.config), input, ctx.config, 'renters', { update: true });
      const updated = await ctx.models.Renter.findOneAndUpdate({ _id: renter._id }, updateWithCustomFields(changes, customFields), { returnDocument: 'after' }).lean();
      const fields = [...Object.keys(changes), ...changedCustomFields(renter, customFields)];
      await recordAudit(ctx, { action: 'renter.updated', entityType: 'renter', entityId: String(renter._id), summary: `Updated ${renter.fullName}: ${fields.join(', ')}` });
      return presentRenter(updated, ctx);
    },

    async addDocument(ctx, renterId, input) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const document = parse(DocumentInputSchema(ctx), input);
      assertCanVerify(ctx, [document]);
      const updated = await ctx.models.Renter.findOneAndUpdate(
        { _id: renter._id },
        { $push: { documents: withVerifier(ctx, document) } },
        { returnDocument: 'after', runValidators: true }
      ).lean();
      if (document.file) await refreshStorage(ctx);
      const scan = document.file ? ' with its scan' : '';
      await recordAudit(ctx, { action: 'renter.document_added', entityType: 'renter', entityId: String(renter._id), summary: `Added a ${document.type} document${scan} to ${renter.fullName}` });
      return presentRenter(updated, ctx);
    },

    /** Attaches the scan of a document, replacing (and deleting) the one it had. */
    async attachDocumentFile(ctx, renterId, documentId, input) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const document = findDocument(renter, documentId);
      const { file } = parse(AttachFileSchema(ctx), input);
      const updated = await ctx.models.Renter.findOneAndUpdate(
        { _id: renter._id, 'documents._id': document._id },
        { $set: { 'documents.$.file': file } },
        { returnDocument: 'after' }
      ).lean();
      await discardFiles(ctx, [document.file], 'document');
      await refreshStorage(ctx);
      await recordAudit(ctx, {
        action: 'renter.document_file_attached',
        entityType: 'renter',
        entityId: String(renter._id),
        summary: `${document.file ? 'Replaced' : 'Attached'} the scan of ${renter.fullName}'s ${document.type}`
      });
      return presentRenter(updated, ctx);
    },

    async verifyDocument(ctx, renterId, documentId) {
      const renter = await findOr404(ctx.models.Renter, renterId, 'Renter');
      const document = findDocument(renter, documentId);
      const updated = await ctx.models.Renter.findOneAndUpdate(
        { _id: renter._id, 'documents._id': document._id },
        { $set: { 'documents.$.verified': true, 'documents.$.verifiedBy': ctx.actor, 'documents.$.verifiedAt': new Date() } },
        { returnDocument: 'after' }
      ).lean();
      await recordAudit(ctx, { action: 'renter.document_verified', entityType: 'renter', entityId: String(renter._id), summary: `Verified ${renter.fullName}'s ${document.type}` });
      return presentRenter(updated, ctx);
    }
  };
}

function findDocument(renter, documentId) {
  const { success } = IdSchema.safeParse(documentId);
  const document = success && renter.documents.find((d) => String(d._id) === documentId);
  if (!document) throw notFound('Document not found');
  return document;
}

module.exports = { createRenters, insertRenter, RENTER_FIELDS };

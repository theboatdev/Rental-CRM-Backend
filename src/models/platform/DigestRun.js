const { Schema } = require('mongoose');
const actorSchema = require('../actor');

const resultSchema = new Schema(
  {
    to: { type: String, required: true },
    ok: { type: Boolean, required: true },
    messageId: { type: String },
    error: { type: String }
  },
  { _id: false }
);

/**
 * One sending of a tenant's WhatsApp digest, on its schedule or by hand. A
 * scheduled run is created before anything is sent, and the unique
 * (tenantId, slot) index lets only one backend instance claim each slot.
 */
const digestRunSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    trigger: { type: String, enum: ['schedule', 'manual'], required: true },
    slot: { type: Date }, // the scheduled minute, for schedule runs
    status: { type: String, enum: ['sending', 'sent', 'partial', 'failed'], default: 'sending' },
    mode: { type: String, enum: ['text', 'template'] },
    includesFinancials: { type: Boolean, default: false },
    results: [resultSchema],
    error: { type: String }, // why nothing could be sent, e.g. no WhatsApp connection
    by: { type: actorSchema }, // who sent it, for manual runs
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date }
  },
  { collection: 'digest_runs', versionKey: false }
);

digestRunSchema.index({ tenantId: 1, slot: 1 }, { unique: true, partialFilterExpression: { trigger: 'schedule' } });
digestRunSchema.index({ tenantId: 1, startedAt: -1 });

module.exports = digestRunSchema;

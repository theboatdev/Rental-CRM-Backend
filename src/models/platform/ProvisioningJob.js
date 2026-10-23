const { Schema } = require('mongoose');
const { PROVISIONING_STEPS } = require('../../platform/tenants/rules');

const stepSchema = new Schema(
  {
    key: { type: String, enum: PROVISIONING_STEPS.map((step) => step.key), required: true },
    label: { type: String, required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    error: { type: String },
    attempts: { type: Number, default: 0 },
    finishedAt: { type: Date }
  },
  { _id: false }
);

/** Step-by-step state of a tenant's setup, so a retry resumes at the failed step. */
const provisioningJobSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    status: { type: String, enum: ['running', 'succeeded', 'failed'], default: 'running' },
    steps: [stepSchema],
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date }
  },
  { collection: 'provisioning_jobs', timestamps: true }
);

provisioningJobSchema.index({ tenantId: 1 }, { unique: true });
provisioningJobSchema.index({ status: 1 });

module.exports = provisioningJobSchema;

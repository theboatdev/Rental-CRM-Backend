const { Schema } = require('mongoose');
const { MEMBER_STATUSES } = require('./enums');
const { ROLE_KEY_PATTERN } = require('../../platform/rbac/permissions');

/**
 * A Clerk user's membership in this tenant. Clerk owns sign-in, so there is no
 * password here; the Clerk webhooks keep these documents in sync.
 */
const memberSchema = new Schema(
  {
    clerkUserId: { type: String, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    roleKey: { type: String, required: true, match: ROLE_KEY_PATTERN },
    status: { type: String, enum: MEMBER_STATUSES, default: 'active' },
    removedAt: { type: Date },
    // Time of the last Clerk event applied, so a late or repeated webhook can't undo a newer one.
    membershipSyncedAt: { type: Date },
    profileSyncedAt: { type: Date }
  },
  { collection: 'members', timestamps: true }
);

memberSchema.index({ clerkUserId: 1 }, { unique: true });
memberSchema.index({ roleKey: 1, status: 1 }); // e.g. counting active owners

module.exports = memberSchema;

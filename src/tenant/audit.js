const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Appends an entry to the tenant's audit log, credited to the caller. */
function recordAudit(ctx, { action, entityType, entityId, summary }) {
  return ctx.models.AuditLog.create({ at: new Date(), actor: ctx.actor, action, entityType, entityId, summary });
}

/** Newest first. `entityType` narrows it to one kind of record, e.g. "member". */
async function listAudit(ctx, { limit = 100, entityType } = {}) {
  const entries = await ctx.models.AuditLog.find(typeof entityType === 'string' ? { entityType } : {})
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .lean();
  return entries.map((entry) => ({
    id: String(entry._id),
    at: iso(entry.at),
    actor: { id: entry.actor.id, name: entry.actor.name },
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    summary: entry.summary
  }));
}

module.exports = { recordAudit, listAudit, iso };

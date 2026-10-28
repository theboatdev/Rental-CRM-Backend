/**
 * What the tenant API's logic needs from a request, after the tenant chain
 * (resolveTenant, loadMember) has run: the tenant's models and config, who is
 * calling, and what they may do. `storage` is the file storage gateway the
 * tenant router was given.
 */
const contextOf = (req) => ({
  models: req.models,
  config: req.config,
  timezone: req.config.locale.timezone,
  tenantId: req.tenant.id,
  orgId: req.identity.orgId,
  role: req.role,
  permissions: req.permissions,
  storage: req.storage,
  actor: { id: req.identity.userId, name: req.member.name || req.member.email }
});

module.exports = { contextOf };

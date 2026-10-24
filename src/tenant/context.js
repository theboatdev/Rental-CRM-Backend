/**
 * What the tenant API's logic needs from a request, after the tenant chain
 * (resolveTenant, loadMember) has run: the tenant's models and config, who is
 * calling, and what they may do.
 */
const contextOf = (req) => ({
  models: req.models,
  config: req.config,
  timezone: req.config.locale.timezone,
  tenantId: req.tenant.id,
  orgId: req.identity.orgId,
  role: req.role,
  permissions: req.permissions,
  actor: { id: req.identity.userId, name: req.member.name || req.member.email }
});

module.exports = { contextOf };

const express = require('express');
const { handle } = require('./handle');
const { getPlatformMeta } = require('../platform/meta');
const { validateConfig } = require('../platform/service');
const { invalid } = require('../platform/errors');
const { requireDatabase } = require('../middleware/database');

/**
 * Accepts a config either as JSON (`config`) or as the raw text of an
 * uploaded file (`configText`), so file syntax errors come back as issues.
 */
function readConfigBody(body) {
  if (typeof body?.configText !== 'string') return { config: body?.config };
  try {
    return { config: JSON.parse(body.configText) };
  } catch (error) {
    return { syntaxIssues: [{ path: '', message: `Invalid JSON: ${error.message}` }] };
  }
}

const invalidJsonResult = (issues) => ({ valid: false, issues, changes: [], removedListKeys: [], customFieldChanges: [] });

/**
 * Super admin API. Every route runs behind `platformAuth`, which sets
 * `req.actor`. The rules (/meta, /config/validate) work without a database;
 * everything after them needs `platformDb` connected.
 */
function createPlatformRouter({ service, tenantUsers, integrations, platformAuth, platformDb }) {
  const router = express.Router();
  router.use(platformAuth);

  router.get('/meta', handle(() => getPlatformMeta()));

  router.post(
    '/config/validate',
    handle((req) => {
      const { config, syntaxIssues } = readConfigBody(req.body);
      return syntaxIssues ? invalidJsonResult(syntaxIssues) : validateConfig(config, req.body?.baseline);
    })
  );

  router.use(requireDatabase(platformDb));

  router.get('/stats', handle(() => service.getStats()));

  router.get('/tenants', handle(() => service.listTenants()));
  router.post('/tenants', handle((req) => service.createTenant(req.body, req.actor), 201));
  router.get('/tenants/:tenantId', handle((req) => service.getTenant(req.params.tenantId)));
  router.patch('/tenants/:tenantId/status', handle((req) => service.setTenantStatus(req.params.tenantId, req.body?.status, req.actor)));
  router.delete('/tenants/:tenantId', handle((req) => service.deleteTenant(req.params.tenantId, { confirmSlug: req.body?.confirmSlug }, req.actor)));

  router.post('/tenants/:tenantId/uploads/logo', handle((req) => service.signLogoUpload(req.params.tenantId), 201));

  router.get('/tenants/:tenantId/provisioning', handle((req) => service.getProvisioningJob(req.params.tenantId)));
  router.post('/tenants/:tenantId/provisioning/retry', handle((req) => service.retryProvisioning(req.params.tenantId, req.actor)));

  router.get('/tenants/:tenantId/config', handle((req) => service.getActiveConfig(req.params.tenantId)));
  router.get('/tenants/:tenantId/config/versions', handle((req) => service.listConfigVersions(req.params.tenantId)));
  router.post(
    '/tenants/:tenantId/config/validate',
    handle((req) => {
      const { config, syntaxIssues } = readConfigBody(req.body);
      return syntaxIssues ? invalidJsonResult(syntaxIssues) : service.validateTenantConfig(req.params.tenantId, config);
    })
  );
  router.post(
    '/tenants/:tenantId/config',
    handle((req) => {
      const { config, syntaxIssues } = readConfigBody(req.body);
      if (syntaxIssues) throw invalid('The uploaded file is not valid JSON', syntaxIssues);
      return service.publishConfig(
        req.params.tenantId,
        { config, note: req.body?.note, baseVersion: req.body?.baseVersion },
        req.actor
      );
    }, 201)
  );
  router.post(
    '/tenants/:tenantId/config/versions/:version/restore',
    handle(
      (req) => service.restoreConfigVersion(req.params.tenantId, Number(req.params.version), req.body?.baseVersion, req.actor),
      201
    )
  );

  // A tenant's users: the same rules as the tenant app's Team page, with the super admin acting as an Owner.
  const users = (tenantPath) => `/tenants/:tenantId/${tenantPath}`;
  router.get(users('members'), handle((req) => tenantUsers.listMembers(req.params.tenantId, req.actor)));
  router.patch(users('members/:memberId'), handle((req) => tenantUsers.changeRole(req.params.tenantId, req.actor, req.params.memberId, req.body?.roleKey)));
  router.delete(users('members/:memberId'), handle((req) => tenantUsers.removeMember(req.params.tenantId, req.actor, req.params.memberId)));
  router.get(users('invitations'), handle((req) => tenantUsers.listInvitations(req.params.tenantId, req.actor)));
  router.post(users('invitations'), handle((req) => tenantUsers.invite(req.params.tenantId, req.actor, req.body), 201));
  router.delete(users('invitations/:invitationId'), handle((req) => tenantUsers.revokeInvitation(req.params.tenantId, req.actor, req.params.invitationId)));
  router.get(users('roles'), handle((req) => tenantUsers.listRoles(req.params.tenantId, req.actor)));

  // The tenant's WhatsApp connection, which sends its digest. The access token is never returned.
  const whatsapp = '/tenants/:tenantId/integrations/whatsapp';
  router.get(whatsapp, handle((req) => integrations.getWhatsApp(req.params.tenantId)));
  router.put(whatsapp, handle((req) => integrations.setWhatsApp(req.params.tenantId, req.body, req.actor)));
  router.delete(whatsapp, handle((req) => integrations.removeWhatsApp(req.params.tenantId, req.actor)));

  router.get(
    '/audit',
    handle((req) =>
      service.listAudit({
        tenantId: typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
        limit: req.query.limit ? Math.min(Number(req.query.limit) || 0, 500) || undefined : undefined
      })
    )
  );

  return router;
}

module.exports = { createPlatformRouter };

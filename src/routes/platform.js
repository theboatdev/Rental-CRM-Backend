const express = require('express');
const { getPlatformMeta } = require('../platform/meta');
const { validateConfig } = require('../platform/service');
const { invalid } = require('../platform/errors');

/**
 * Wraps a handler that returns the response body (or a promise of it) so
 * thrown errors and rejections reach the error middleware.
 */
const handle =
  (fn, status = 200) =>
  (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .then((body) => res.status(status).json(body))
      .catch(next);

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

const invalidJsonResult = (issues) => ({ valid: false, issues, changes: [], removedListKeys: [] });

/** Super admin API. Every route runs behind `platformAuth`, which sets `req.actor`. */
function createPlatformRouter({ service, platformAuth }) {
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

  router.get('/stats', handle(() => service.getStats()));

  router.get('/tenants', handle(() => service.listTenants()));
  router.post('/tenants', handle((req) => service.createTenant(req.body, req.actor), 201));
  router.get('/tenants/:tenantId', handle((req) => service.getTenant(req.params.tenantId)));
  router.patch('/tenants/:tenantId/status', handle((req) => service.setTenantStatus(req.params.tenantId, req.body?.status, req.actor)));

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

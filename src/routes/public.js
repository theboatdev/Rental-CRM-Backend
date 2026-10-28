const express = require('express');
const { handle } = require('./handle');
const { requireDatabase } = require('../middleware/database');
const { rateLimit } = require('../middleware/rateLimit');
const { notFound } = require('../platform/errors');
const { createStorageGateway } = require('../platform/storage');
const { createPortal, publicContextOf } = require('../tenant/portal');

/** Requests per client IP: every route, then the uploads and bookings on top. */
const PUBLIC_RATE_LIMITS = {
  requests: { windowMs: 60_000, max: 120 },
  uploads: { windowMs: 10 * 60_000, max: 30 },
  bookings: { windowMs: 10 * 60_000, max: 5 }
};

/**
 * Finds the tenant of `/api/public/:slug`. The page only exists for an active
 * tenant whose config turns `modules.guestPortal` on; otherwise it's a 404.
 * Lookups are cached like resolveTenant's.
 */
function resolvePublicTenant({ directory, getTenantDb, cacheTtlMs = 60_000, now = Date.now }) {
  const cache = new Map();

  async function lookup(slug) {
    const hit = cache.get(slug);
    if (hit && now() - hit.at < cacheTtlMs) return hit.found;
    const found = await directory.findTenantBySlug(slug);
    if (found) cache.set(slug, { at: now(), found });
    else cache.delete(slug);
    return found;
  }

  return (req, res, next) =>
    lookup(req.params.slug)
      .then((found) => {
        const config = found?.activeConfig?.config;
        if (!config || found.tenant.status !== 'active' || !config.modules.guestPortal.enabled) throw notFound("This booking page isn't available");
        req.tenant = { id: found.tenant.id, name: found.tenant.name, slug: found.tenant.slug };
        req.config = config;
        req.models = getTenantDb(found.tenant.dbName).models;
        next();
      })
      .catch(next);
}

/**
 * The guest booking portal under /api/public/:slug: no sign-in, rate-limited
 * per client IP, and only for tenants with the guest portal on. See src/tenant/portal.js.
 */
function createPublicRouter({ platformDb, getTenantDb, directory, storage = createStorageGateway({}), cacheTtlMs, limits = PUBLIC_RATE_LIMITS }) {
  const portal = platformDb && createPortal({ platformDb });
  const router = express.Router({ mergeParams: true });
  router.use(rateLimit(limits.requests), requireDatabase(platformDb), resolvePublicTenant({ directory, getTenantDb, cacheTtlMs }), (req, res, next) => {
    req.storage = storage;
    next();
  });

  router.get('/', handle((req) => portal.profile(publicContextOf(req))));
  router.get('/vehicles', handle((req) => portal.vehicles(publicContextOf(req), req.query)));
  router.post('/uploads', rateLimit(limits.uploads), handle((req) => portal.signUpload(publicContextOf(req), req.body), 201));
  router.post('/bookings', rateLimit(limits.bookings), handle((req) => portal.book(publicContextOf(req), req.body), 201));

  return router;
}

module.exports = { createPublicRouter, PUBLIC_RATE_LIMITS };

const express = require('express');
const { verifyWebhook } = require('@clerk/express/webhooks');
const { requireDatabase } = require('../middleware/database');
const { PlatformError, unavailable } = require('../platform/errors');

/**
 * Inbound webhooks under /webhooks. Mount before `express.json()`: the
 * signature covers the raw body. A 4xx tells Clerk not to retry; a 5xx (e.g.
 * while the database is down) makes it retry with backoff.
 */
function createWebhookRouter({ platformDb, signingSecret, memberSync }) {
  const router = express.Router();

  router.post(
    '/clerk',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res, next) =>
      signingSecret ? next() : next(unavailable('webhooks_not_configured', 'Set CLERK_WEBHOOK_SIGNING_SECRET on the backend')),
    requireDatabase(platformDb),
    async (req, res, next) => {
      let event;
      try {
        event = await verifyWebhook(req, { signingSecret });
      } catch {
        return next(new PlatformError('Invalid webhook signature', { status: 400, code: 'invalid_signature' }));
      }
      try {
        res.json({ received: true, applied: await memberSync.handle(event) });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = { createWebhookRouter };

const { handle } = require('./handle');
const { requireModule, requirePermission, requireAnyPermission } = require('../middleware/tenantContext');
const { contextOf } = require('../tenant/context');
const { createVehicles } = require('../tenant/vehicles');
const { createRenters } = require('../tenant/renters');
const { createRentals } = require('../tenant/rentals');
const { createPayments } = require('../tenant/payments');
const { createCosts } = require('../tenant/costs');
const { createDashboard } = require('../tenant/dashboard');
const { createUploads, UPLOAD_PERMISSIONS } = require('../tenant/files');

/** `requireModule` then `requirePermission`, so a disabled module is a 404 before permissions are checked. */
const guard = (moduleKey, permission) => [requireModule(moduleKey), requirePermission(permission)];

/**
 * The day-to-day operations routes of the tenant API, registered on its
 * router (after the tenant chain). `digests` sends the WhatsApp digest (src/platform/digests.js).
 */
function registerOperationRoutes(router, { platformDb, digests }) {
  const vehicles = createVehicles({ platformDb });
  const renters = createRenters({ platformDb });
  const rentals = createRentals({ platformDb });
  const payments = createPayments();
  const costs = createCosts({ platformDb });
  const dashboard = createDashboard();
  const uploads = createUploads({ platformDb });
  const query = (req) => req.query;

  // Signs a browser upload to Cloudinary. Each kind checks its own module and permissions (files.js).
  router.post('/uploads', requireAnyPermission(...UPLOAD_PERMISSIONS), handle((req) => uploads.signUpload(contextOf(req), req.body), 201));

  router.get('/dashboard', guard('dashboard', 'dashboard:view'), handle((req) => dashboard.dashboard(contextOf(req), query(req))));

  // Before /vehicles/:id, which would otherwise match it.
  router.get('/vehicles/availability', guard('rentals', 'rentals:create'), handle((req) => rentals.availability(contextOf(req), query(req))));
  router.get('/vehicles', guard('vehicles', 'vehicles:read'), handle((req) => vehicles.listVehicles(contextOf(req))));
  router.get('/vehicles/:id', guard('vehicles', 'vehicles:read'), handle((req) => vehicles.getVehicle(contextOf(req), req.params.id)));
  router.post('/vehicles', guard('vehicles', 'vehicles:create'), handle((req) => vehicles.createVehicle(contextOf(req), req.body), 201));
  router.patch('/vehicles/:id', guard('vehicles', 'vehicles:update'), handle((req) => vehicles.updateVehicle(contextOf(req), req.params.id, req.body)));
  router.delete('/vehicles/:id', guard('vehicles', 'vehicles:delete'), handle((req) => vehicles.deleteVehicle(contextOf(req), req.params.id)));

  router.get('/renters', guard('renters', 'renters:read'), handle((req) => renters.listRenters(contextOf(req))));
  router.get('/renters/:id', guard('renters', 'renters:read'), handle((req) => renters.getRenter(contextOf(req), req.params.id)));
  router.post('/renters', guard('renters', 'renters:create'), handle((req) => renters.createRenter(contextOf(req), req.body), 201));
  router.patch('/renters/:id', guard('renters', 'renters:update'), handle((req) => renters.updateRenter(contextOf(req), req.params.id, req.body)));
  router.post('/renters/:id/documents', guard('renters', 'renters:update'), handle((req) => renters.addDocument(contextOf(req), req.params.id, req.body), 201));
  router.put(
    '/renters/:id/documents/:documentId/file',
    guard('renters', 'renters:update'),
    handle((req) => renters.attachDocumentFile(contextOf(req), req.params.id, req.params.documentId, req.body))
  );
  router.post(
    '/renters/:id/documents/:documentId/verify',
    guard('renters', 'renters:documents:verify'),
    handle((req) => renters.verifyDocument(contextOf(req), req.params.id, req.params.documentId))
  );

  router.get('/rentals', guard('rentals', 'rentals:read'), handle((req) => rentals.listRentals(contextOf(req), query(req))));
  router.get('/rentals/:id', guard('rentals', 'rentals:read'), handle((req) => rentals.getRental(contextOf(req), req.params.id)));
  router.post('/rentals', guard('rentals', 'rentals:create'), handle((req) => rentals.reserve(contextOf(req), req.body), 201));
  router.patch('/rentals/:id', guard('rentals', 'rentals:create'), handle((req) => rentals.updateRental(contextOf(req), req.params.id, req.body)));
  router.post('/rentals/:id/check-in', guard('rentals', 'rentals:checkin'), handle((req) => rentals.checkIn(contextOf(req), req.params.id, req.body)));
  router.post('/rentals/:id/return', guard('rentals', 'rentals:return'), handle((req) => rentals.returnRental(contextOf(req), req.params.id, req.body)));
  router.post('/rentals/:id/cancel', guard('rentals', 'rentals:cancel'), handle((req) => rentals.cancel(contextOf(req), req.params.id)));

  router.get('/calendar', guard('calendar', 'calendar:view'), handle((req) => rentals.calendar(contextOf(req), query(req))));

  router.get('/payments', guard('payments', 'payments:read'), handle((req) => payments.listPayments(contextOf(req), query(req))));
  router.post('/payments', guard('payments', 'payments:record'), handle((req) => payments.recordPayment(contextOf(req), req.body), 201));
  router.post('/payments/:id/void', guard('payments', 'payments:void'), handle((req) => payments.voidPayment(contextOf(req), req.params.id, req.body)));

  router.get('/costs', guard('costs', 'costs:read'), handle((req) => costs.listCosts(contextOf(req), query(req))));
  router.post('/costs', guard('costs', 'costs:create'), handle((req) => costs.createCost(contextOf(req), req.body), 201));
  router.put('/costs/:id/bill', guard('costs', 'costs:create'), handle((req) => costs.attachBill(contextOf(req), req.params.id, req.body)));
  router.delete('/costs/:id', guard('costs', 'costs:delete'), handle((req) => costs.deleteCost(contextOf(req), req.params.id)));

  router.get('/fuel-logs', guard('fuelLogs', 'fuel:read'), handle((req) => costs.listFuelLogs(contextOf(req), query(req))));
  router.post('/fuel-logs', guard('fuelLogs', 'fuel:create'), handle((req) => costs.createFuelLog(contextOf(req), req.body), 201));

  router.get(
    '/whatsapp/digest',
    guard('whatsappDigest', 'whatsapp:view'),
    handle(async (req) => {
      const ctx = contextOf(req);
      return { ...(await dashboard.whatsappDigest(ctx)), delivery: digests ? await digests.deliveryOf(ctx.tenantId) : null };
    })
  );
  router.post('/whatsapp/digest/send', guard('whatsappDigest', 'whatsapp:manage'), handle((req) => digests.sendNow(contextOf(req)), 201));
}

module.exports = { registerOperationRoutes };

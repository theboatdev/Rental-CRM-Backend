const { handle } = require('./handle');
const { requireModule, requirePermission } = require('../middleware/tenantContext');
const { contextOf } = require('../tenant/context');
const { createVehicles } = require('../tenant/vehicles');
const { createRenters } = require('../tenant/renters');
const { createRentals } = require('../tenant/rentals');
const { createPayments } = require('../tenant/payments');
const { createCosts } = require('../tenant/costs');
const { createDashboard } = require('../tenant/dashboard');

/** `requireModule` then `requirePermission`, so a disabled module is a 404 before permissions are checked. */
const guard = (moduleKey, permission) => [requireModule(moduleKey), requirePermission(permission)];

/** The day-to-day operations routes of the tenant API, registered on its router (after the tenant chain). */
function registerOperationRoutes(router, { platformDb }) {
  const vehicles = createVehicles({ platformDb });
  const renters = createRenters();
  const rentals = createRentals();
  const payments = createPayments();
  const costs = createCosts();
  const dashboard = createDashboard();
  const query = (req) => req.query;

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
  router.post(
    '/renters/:id/documents/:documentId/verify',
    guard('renters', 'renters:documents:verify'),
    handle((req) => renters.verifyDocument(contextOf(req), req.params.id, req.params.documentId))
  );

  router.get('/rentals', guard('rentals', 'rentals:read'), handle((req) => rentals.listRentals(contextOf(req), query(req))));
  router.get('/rentals/:id', guard('rentals', 'rentals:read'), handle((req) => rentals.getRental(contextOf(req), req.params.id)));
  router.post('/rentals', guard('rentals', 'rentals:create'), handle((req) => rentals.reserve(contextOf(req), req.body), 201));
  router.post('/rentals/:id/check-in', guard('rentals', 'rentals:checkin'), handle((req) => rentals.checkIn(contextOf(req), req.params.id, req.body)));
  router.post('/rentals/:id/return', guard('rentals', 'rentals:return'), handle((req) => rentals.returnRental(contextOf(req), req.params.id, req.body)));
  router.post('/rentals/:id/cancel', guard('rentals', 'rentals:cancel'), handle((req) => rentals.cancel(contextOf(req), req.params.id)));

  router.get('/calendar', guard('calendar', 'calendar:view'), handle((req) => rentals.calendar(contextOf(req), query(req))));

  router.get('/payments', guard('payments', 'payments:read'), handle((req) => payments.listPayments(contextOf(req), query(req))));
  router.post('/payments', guard('payments', 'payments:record'), handle((req) => payments.recordPayment(contextOf(req), req.body), 201));
  router.post('/payments/:id/void', guard('payments', 'payments:void'), handle((req) => payments.voidPayment(contextOf(req), req.params.id, req.body)));

  router.get('/costs', guard('costs', 'costs:read'), handle((req) => costs.listCosts(contextOf(req), query(req))));
  router.post('/costs', guard('costs', 'costs:create'), handle((req) => costs.createCost(contextOf(req), req.body), 201));
  router.delete('/costs/:id', guard('costs', 'costs:delete'), handle((req) => costs.deleteCost(contextOf(req), req.params.id)));

  router.get('/fuel-logs', guard('fuelLogs', 'fuel:read'), handle((req) => costs.listFuelLogs(contextOf(req), query(req))));
  router.post('/fuel-logs', guard('fuelLogs', 'fuel:create'), handle((req) => costs.createFuelLog(contextOf(req), req.body), 201));

  router.get('/whatsapp/digest', guard('whatsappDigest', 'whatsapp:view'), handle((req) => dashboard.whatsappDigest(contextOf(req))));
}

module.exports = { registerOperationRoutes };

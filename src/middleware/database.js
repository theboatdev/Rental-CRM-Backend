const { isConnected } = require('../db/platform');
const { unavailable } = require('../platform/errors');

/** 503 unless the platform database is configured and connected, so the caller (or Clerk's webhook retries) can try again later. */
function requireDatabase(platformDb) {
  return (req, res, next) => {
    if (!platformDb) return next(unavailable('database_not_configured', 'Set MONGODB_URI on the backend'));
    if (!isConnected(platformDb)) return next(unavailable('database_unavailable', "The backend can't reach its database"));
    next();
  };
}

module.exports = { requireDatabase };

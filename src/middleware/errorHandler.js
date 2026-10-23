const { PlatformError } = require('../platform/errors');

/**
 * Reports every error in one shape: `{ error: { code, message, issues? } }`.
 * Express recognizes an error handler by its four parameters, so `next` stays.
 */
function errorHandler(err, req, res, next) {
  if (err instanceof PlatformError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, issues: err.issues } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  console.error(err.stack);
  res.status(err.status || 500).json({ error: { code: 'internal', message: 'Internal Server Error' } });
}

module.exports = { errorHandler };

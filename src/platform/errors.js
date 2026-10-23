/** An expected failure the API reports to the caller with an HTTP status. */
class PlatformError extends Error {
  constructor(message, { status = 400, code = 'invalid', issues } = {}) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

const unauthenticated = (message) => new PlatformError(message, { status: 401, code: 'unauthenticated' });
const forbidden = (message) => new PlatformError(message, { status: 403, code: 'forbidden' });
const notFound = (message) => new PlatformError(message, { status: 404, code: 'not_found' });
const conflict = (message) => new PlatformError(message, { status: 409, code: 'conflict' });
const invalid = (message, issues) => new PlatformError(message, { status: 422, code: 'invalid', issues });
const unavailable = (code, message) => new PlatformError(message, { status: 503, code });

module.exports = { PlatformError, unauthenticated, forbidden, notFound, conflict, invalid, unavailable };

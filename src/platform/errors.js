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

const notFound = (message) => new PlatformError(message, { status: 404, code: 'not_found' });
const conflict = (message) => new PlatformError(message, { status: 409, code: 'conflict' });
const invalid = (message, issues) => new PlatformError(message, { status: 422, code: 'invalid', issues });

module.exports = { PlatformError, notFound, conflict, invalid };

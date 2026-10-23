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

module.exports = { handle };

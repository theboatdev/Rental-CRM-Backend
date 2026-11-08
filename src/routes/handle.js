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
 * Like `handle`, for a handler that returns a file:
 * `{ filename, contentType, body }`, with `body` a Buffer. It's sent as a
 * download, never cached.
 */
const handleFile =
  (fn) =>
  (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .then(({ filename, contentType, body }) => {
        res.set({
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          // Lets the apps read the file name across origins.
          'Access-Control-Expose-Headers': 'Content-Disposition'
        });
        res.status(200).end(body);
      })
      .catch(next);

module.exports = { handle, handleFile };

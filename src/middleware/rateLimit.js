const { PlatformError } = require('../platform/errors');

/**
 * At most `max` requests per client IP in each `windowMs`, counted in memory,
 * so each backend instance counts on its own. Behind a load balancer, set
 * TRUST_PROXY so `req.ip` is the client's address and not the balancer's.
 * Over the limit: 429 `rate_limited`, with Retry-After in seconds.
 */
function rateLimit({ windowMs, max, now = Date.now }) {
  const windows = new Map(); // ip → { start, count }

  const sweep = (at) => {
    for (const [ip, window] of windows) if (at - window.start >= windowMs) windows.delete(ip);
  };

  return (req, res, next) => {
    const at = now();
    if (windows.size > 10_000) sweep(at);
    let window = windows.get(req.ip);
    if (!window || at - window.start >= windowMs) {
      window = { start: at, count: 0 };
      windows.set(req.ip, window);
    }
    window.count += 1;
    if (window.count <= max) return next();
    res.set('Retry-After', String(Math.ceil((window.start + windowMs - at) / 1000)));
    next(new PlatformError('Too many requests. Wait a little and try again.', { status: 429, code: 'rate_limited' }));
  };
}

module.exports = { rateLimit };

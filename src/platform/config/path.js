/** Formats a path like ['modules', 'rentals', 'inspectionPoints', 2] as `modules.rentals.inspectionPoints[2]`. */
function formatPath(segments) {
  return segments.reduce((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;
    const key = String(segment);
    return path ? `${path}.${key}` : key;
  }, '');
}

module.exports = { formatPath };

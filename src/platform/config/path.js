/** Formats a path like ['modules', 'rentals', 'inspectionPoints', 2] as `modules.rentals.inspectionPoints[2]`. */
function formatPath(segments) {
  return segments.reduce((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;
    const key = String(segment);
    return path ? `${path}.${key}` : key;
  }, '');
}

/** A Zod error's issues in the API's `{ path, message }` shape. */
const zodIssues = (error) => error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));

module.exports = { formatPath, zodIssues };

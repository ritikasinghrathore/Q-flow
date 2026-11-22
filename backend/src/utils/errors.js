class AppError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
module.exports = {
  AppError,
  badRequest: (m = 'Invalid request') => new AppError(400, 'bad_request', m),
  unauthorized: (m = 'Please log in') => new AppError(401, 'unauthorized', m),
  forbidden: (m = 'You do not have access to this') => new AppError(403, 'forbidden', m),
  notFound: (m = 'Not found') => new AppError(404, 'not_found', m),
  conflict: (m = 'Conflict') => new AppError(409, 'conflict', m),
};

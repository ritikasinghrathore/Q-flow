const { ZodError } = require('zod'); const log = require('../config/logger'); const { AppError } = require('../utils/errors');
module.exports = (err, req, res, _next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: { code: 'validation_failed', message: 'Some fields are invalid', details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) } });
  if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.code === '22P02') return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid identifier' } });
  if (err.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'That already exists or is already active' } });
  log.error({ err: err.message, stack: err.stack, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } });
};

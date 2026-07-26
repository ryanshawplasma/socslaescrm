'use strict';

class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.name   = 'AppError';
  }
}

function globalErrorHandler(err, req, res, _next) {
  // PostgreSQL unique violation → clean 409 instead of a 500
  if (err.code === '23505') {
    if (!res.headersSent) return res.status(409).json({ error: 'Already exists — choose a different value' });
    return;
  }
  // Foreign-key violation (e.g. deleting a user who still owns a team) → a clear
  // 409 the client can show, instead of a bare 500.
  if (err.code === '23503') {
    if (!res.headersSent) return res.status(409).json({ error: 'Can’t delete — this is still linked to other records. Reassign or remove those first.' });
    return;
  }
  const status  = err.status || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}:`, err.message);
  }
  if (!res.headersSent) res.status(status).json({ error: message });
}

module.exports = { AppError, globalErrorHandler };

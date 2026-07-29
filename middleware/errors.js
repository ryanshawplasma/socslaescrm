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
  // Bad input that reached Postgres is the CLIENT's fault, not ours — report it
  // as 4xx. Without these, a request like PATCH /api/lead-lists/abc turned NaN
  // into an invalid-text-representation error that fell through to a generic
  // 500 and got logged as a server fault, burying real failures in noise.
  if (err.code === '22P02') {   // invalid text representation (e.g. NaN as an int)
    if (!res.headersSent) return res.status(400).json({ error: 'Invalid value in request' });
    return;
  }
  if (err.code === '22001') {   // value too long for column
    if (!res.headersSent) return res.status(400).json({ error: 'One of the values is too long' });
    return;
  }
  if (err.code === '22003') {   // numeric value out of range
    if (!res.headersSent) return res.status(400).json({ error: 'A number in the request is out of range' });
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

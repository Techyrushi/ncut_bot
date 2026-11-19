import type { ErrorRequestHandler } from 'express';
import { logger } from '../config/logger';
import { ApiError } from '../utils/api-error';

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }

  if (error?.name === 'ZodError') {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' } });
    return;
  }

  if (error?.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the allowed size' },
    });
    return;
  }

  if (error?.code === 11000) {
    res.status(409).json({ success: false, error: { code: 'DUPLICATE_RESOURCE', message: 'Resource already exists' } });
    return;
  }

  if (error?.name === 'CastError' || error?.name === 'ValidationError') {
    res.status(400).json({ success: false, error: { code: 'INVALID_DATA', message: 'Request contains invalid data' } });
    return;
  }

  logger.error({ err: error }, 'Unhandled request error');
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};

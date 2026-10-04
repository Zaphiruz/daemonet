/**
 * Every API error body is `{ error, message }`. Codes: `validation_error` / `bad_request` / `not_found` / `conflict`
 * (400/404/409, with a short reason), `unauthorized` (401), `forbidden` (403), `payload_too_large` (413),
 * `rate_limited` (429), `internal_error` (500), `unavailable` (503: the identity provider is unreachable while a bearer
 * token is checked; retry later).
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, 'validation_error', message);
export const unauthorized = (message: string) => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const rateLimited = () => new AppError(429, 'rate_limited', 'rate limit exceeded');
export const authUnavailable = () => new AppError(503, 'unavailable', 'authentication temporarily unavailable');

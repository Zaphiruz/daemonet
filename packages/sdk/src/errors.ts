import type { ErrorCode } from '@daemonet/shared';

/** A rejected command or server error. `code` is one of the protocol error codes. */
export class DaemonetError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DaemonetError';
  }
}

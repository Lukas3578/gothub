/**
 * Einheitliche Fehlerbehandlung.
 *
 * Alle erwarteten Fehler werden als `ApiError` geworfen und vom zentralen
 * Error-Handler in das Format aus @forge/shared übersetzt. Unerwartete Fehler
 * werden protokolliert, aber nie im Detail an den Client gegeben – Stacktraces
 * und Datenbankmeldungen verraten interne Struktur.
 */

import type { ApiErrorCode } from '@forge/shared';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  maintenance: 503,
  two_factor_required: 401,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(code: ApiErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

export const badRequest = (message: string) => new ApiError('bad_request', message);

export const validationFailed = (message: string, fieldErrors?: Record<string, string[]>) =>
  new ApiError('validation_failed', message, fieldErrors);

export const unauthenticated = (message = 'Anmeldung erforderlich.') =>
  new ApiError('unauthenticated', message);

export const forbidden = (message = 'Keine Berechtigung für diese Aktion.') =>
  new ApiError('forbidden', message);

/**
 * Wird auch verwendet, wenn ein Objekt zwar existiert, der Benutzer es aber
 * nicht sehen darf. Ein 403 würde die Existenz privater Repositories
 * bestätigen; deshalb ist 404 hier die richtige Antwort.
 */
export const notFound = (message = 'Nicht gefunden.') => new ApiError('not_found', message);

export const conflict = (message: string) => new ApiError('conflict', message);

export const payloadTooLarge = (message: string) => new ApiError('payload_too_large', message);

export const twoFactorRequired = () =>
  new ApiError('two_factor_required', 'Zwei-Faktor-Code erforderlich.');

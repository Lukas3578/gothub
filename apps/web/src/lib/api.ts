/**
 * API-Client.
 *
 * Kümmert sich um drei Dinge, die sonst in jeder Komponente stünden:
 *  - Cookies mitsenden (credentials: 'include')
 *  - den CSRF-Token aus dem Cookie in den Header spiegeln
 *  - Fehlerantworten in eine typisierte Exception übersetzen
 */

import type { ApiErrorBody, ApiErrorCode } from '@forge/shared';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const CSRF_COOKIE = 'fg_csrf';
const CSRF_HEADER = 'x-forge-csrf';

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.fieldErrors = body.fieldErrors ?? {};
  }

  /** Erste Fehlermeldung für ein bestimmtes Feld. */
  fieldError(field: string): string | undefined {
    return this.fieldErrors[field]?.[0];
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Rohe Antwort zurückgeben statt JSON zu parsen (für Downloads). */
  raw?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  // Der CSRF-Token wird nur bei verändernden Methoden gebraucht.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (options.raw) {
    if (!response.ok) await throwApiError(response);
    return response as unknown as T;
  }

  if (!response.ok) await throwApiError(response);

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function throwApiError(response: Response): Promise<never> {
  let body: ApiErrorBody['error'];
  try {
    const parsed = (await response.json()) as ApiErrorBody;
    body = parsed.error;
  } catch {
    body = {
      code: 'internal_error',
      message: `Unerwartete Antwort (HTTP ${response.status}).`,
    };
  }
  throw new ApiRequestError(response.status, body);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiFetch<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'DELETE', body }),
};

export { BASE_URL };

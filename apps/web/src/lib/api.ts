/**
 * API-Client.
 *
 * Kümmert sich um vier Dinge, die sonst in jeder Komponente stünden:
 *  - Cookies mitsenden (credentials: 'include')
 *  - den CSRF-Token beschaffen und als Header mitgeben
 *  - einen abgelaufenen Token einmalig erneuern und die Anfrage wiederholen
 *  - Fehlerantworten in eine typisierte Exception übersetzen
 *
 * Zum CSRF-Token: er kommt aus dem Antwortkörper von GET /api/v1/auth/csrf,
 * nicht aus einem Cookie. Grund: Frontend und API können auf verschiedenen
 * Hosts liegen, und ein Browser lässt `document.cookie` ausschließlich
 * Cookies des eigenen Hosts lesen. Ein Cookie der API ist für diese Seite
 * also unsichtbar. Lesen darf die Antwort nur eine Origin, die serverseitig
 * zugelassen ist – damit bleibt der Token vor fremden Seiten geschützt.
 */

import type { ApiErrorBody, ApiErrorCode } from '@forge/shared';

/**
 * Adresse der API.
 *
 * `VITE_API_URL` wird beim Bauen eingesetzt. Für den Produktionsbuild steht
 * der Wert in `apps/web/.env.production`, sodass kein Eintrag im Dashboard
 * des Hosting-Anbieters nötig ist.
 *
 * Fehlt die Variable, wird NICHT auf localhost zurückgefallen – ein
 * Produktionsbundle, das auf den eigenen Rechner zeigt, wäre der schwer
 * auffindbare Fehler, den dieser Zweig verhindert. Stattdessen wird dieselbe
 * Herkunft wie die Seite verwendet, was bei einem Reverse Proxy korrekt ist,
 * und in der Entwicklung localhost.
 */
function resolveBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');

  if (import.meta.env.DEV) return 'http://localhost:4000';

  // Produktion ohne gesetzte Variable: gleiche Herkunft annehmen.
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

const BASE_URL = resolveBaseUrl();
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

// ---------------------------------------------------------------------------
// CSRF-Token
// ---------------------------------------------------------------------------

/**
 * Der Token liegt nur im Speicher, nicht in localStorage.
 *
 * Nach einem Reload ist er weg und wird neu geholt – das ist gewollt: ein
 * gespeicherter Token würde nach einem Serverneustart oder einem Wechsel der
 * Sitzung nicht mehr passen und müsste trotzdem erneuert werden.
 */
let csrfToken: string | null = null;
/** Verhindert, dass bei mehreren gleichzeitigen Anfragen parallel geholt wird. */
let csrfRequest: Promise<string | null> | null = null;

/** Übernimmt einen Token, den eine Antwort mitgeliefert hat. */
export function rememberCsrfToken(token: string | null | undefined): void {
  if (token) csrfToken = token;
}

async function fetchCsrfToken(): Promise<string | null> {
  const response = await fetch(`${BASE_URL}/api/v1/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) return null;

  const body = (await response.json().catch(() => null)) as { csrfToken?: string } | null;
  csrfToken = body?.csrfToken ?? null;
  return csrfToken;
}

async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;

  // Mehrere gleichzeitige schreibende Anfragen sollen sich eine Abfrage teilen.
  csrfRequest ??= fetchCsrfToken().finally(() => {
    csrfRequest = null;
  });

  return csrfRequest;
}

/** Erzwingt beim nächsten Bedarf einen frischen Token. */
function invalidateCsrfToken(): void {
  csrfToken = null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Anfragen
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Rohe Antwort zurückgeben statt JSON zu parsen (für Downloads). */
  raw?: boolean;
}

async function send(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token && !SAFE_METHODS.has(method)) headers[CSRF_HEADER] = token;

  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    // Ohne 'include' sendet der Browser bei getrennten Hosts keine Cookies –
    // der Benutzer wäre bei jeder Anfrage abgemeldet.
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const needsToken = !SAFE_METHODS.has(method);

  let token = needsToken ? await ensureCsrfToken() : null;
  let response = await send(path, options, token);

  /**
   * Ein 403 wegen fehlenden oder abgelaufenen Tokens wird genau einmal
   * wiederholt. Das tritt im Alltag auf: das Cookie läuft nach einer Woche
   * ab, und nach einem Serverneustart passt ein alter Token nicht mehr. Ohne
   * diesen Zweig müsste der Benutzer die Seite neu laden.
   */
  if (needsToken && response.status === 403) {
    const body = await response
      .clone()
      .json()
      .catch(() => null);

    const isCsrfProblem =
      (body as ApiErrorBody | null)?.error?.code === 'forbidden' &&
      /csrf/i.test((body as ApiErrorBody | null)?.error?.message ?? '');

    if (isCsrfProblem) {
      invalidateCsrfToken();
      token = await ensureCsrfToken();
      if (token) response = await send(path, options, token);
    }
  }

  if (options.raw) {
    if (!response.ok) await throwApiError(response);
    return response as unknown as T;
  }

  if (!response.ok) await throwApiError(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  const parsed = JSON.parse(text) as T & { csrfToken?: string };
  // Antworten dürfen einen frischen Token mitliefern (etwa /auth/me).
  rememberCsrfToken(parsed?.csrfToken);
  return parsed;
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

/**
 * Sendet einen rohen Körper, etwa ein Bild.
 *
 * Eigene Funktion, weil `apiFetch` den Körper als JSON kodiert. Die
 * CSRF-Behandlung ist dieselbe, damit der Upload nicht an einem fehlenden
 * Token scheitert.
 */
export async function apiUpload(
  path: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const run = async (token: string | null): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...extraHeaders,
        ...(token ? { [CSRF_HEADER]: token } : {}),
      },
      credentials: 'include',
      body: body as BodyInit,
    });

  let token = await ensureCsrfToken();
  let response = await run(token);

  if (response.status === 403) {
    invalidateCsrfToken();
    token = await ensureCsrfToken();
    if (token) response = await run(token);
  }

  if (!response.ok) await throwApiError(response);
  return response.json().catch(() => null);
}

export { BASE_URL };

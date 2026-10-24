/**
 * Request-Kontext: Authentifizierung, CSRF-Schutz, Wartungsmodus.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { resolveApiToken, resolveSession, type AuthenticatedUser } from '../services/auth.js';
import { generateToken, safeEqual } from '../lib/crypto.js';
import { ApiError, forbidden, unauthenticated } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Angemeldeter Benutzer oder null bei anonymen Anfragen. */
    viewer: AuthenticatedUser | null;
    /** Session-ID, falls die Authentifizierung über ein Cookie lief. */
    sessionId: string | null;
    /** Wie sich der Benutzer ausgewiesen hat. */
    authMethod: 'session' | 'token' | null;
    /**
     * Der für diese Anfrage gültige CSRF-Token. Wird von
     * GET /api/v1/auth/csrf an den Client ausgeliefert.
     */
    csrfToken: string | null;
  }

  interface FastifyInstance {
    /** Bricht ab, wenn kein Benutzer angemeldet ist. */
    requireAuth(request: FastifyRequest): asserts request is FastifyRequest & {
      viewer: AuthenticatedUser;
    };
    /** Bricht ab, wenn der Benutzer kein Plattform-Administrator ist. */
    requireAdmin(request: FastifyRequest): asserts request is FastifyRequest & {
      viewer: AuthenticatedUser;
    };
  }
}

/** Methoden, die den Zustand nicht verändern und deshalb keinen CSRF-Token brauchen. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pfade, die vom CSRF-Schutz ausgenommen sind.
 *
 * Git-Clients senden keine Cookies im Browser-Sinn und können keinen
 * CSRF-Header setzen. Sie authentifizieren sich ausschließlich über HTTP Basic
 * mit einem API-Token – dort greift CSRF konstruktionsbedingt nicht, weil ein
 * Browser den Authorization-Header nicht automatisch mitschickt.
 */
function isCsrfExempt(request: FastifyRequest): boolean {
  if (request.url.startsWith('/git/')) return true;
  // Die Runner-API authentifiziert sich per Bearer-Token, nicht per Cookie.
  if (request.url.startsWith('/api/v1/runner/')) return true;
  // npm schickt kein Cookie und kann keinen CSRF-Header setzen; die Registry
  // akzeptiert ausschließlich Bearer-Tokens, auf die CSRF nicht anwendbar ist.
  if (request.url.startsWith('/npm/')) return true;
  // Interne Aufrufe aus Git-Hooks weisen sich über das Hook-Geheimnis aus.
  // Ein Browser kann diesen Header nicht setzen, CSRF greift hier also nicht.
  if (request.url.startsWith('/internal/')) return true;
  // Token-Authentifizierung ist per se nicht CSRF-anfällig.
  if (request.authMethod === 'token') return true;
  return false;
}

export const contextPlugin = fp(async (app: FastifyInstance) => {
  // -- Authentifizierung ----------------------------------------------------
  app.decorateRequest('viewer', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('authMethod', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    // 1. Bearer- oder Basic-Token (API-Clients, Git über HTTPS).
    const authHeader = request.headers.authorization;
    if (authHeader) {
      let token: string | null = null;

      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else if (authHeader.startsWith('Basic ')) {
        // Git sendet Benutzername:Token. Der Benutzername wird nicht geprüft –
        // das Token identifiziert den Account eindeutig.
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator !== -1) token = decoded.slice(separator + 1);
      }

      if (token) {
        const user = await resolveApiToken(token);
        if (user) {
          request.viewer = user;
          request.authMethod = 'token';
          return;
        }
      }
    }

    // 2. Session-Cookie.
    const cookie = request.cookies[config.security.sessionCookieName];
    if (cookie) {
      const unsigned = request.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value) {
        const resolved = await resolveSession(unsigned.value);
        if (resolved) {
          request.viewer = resolved.user;
          request.sessionId = resolved.sessionId;
          request.authMethod = 'session';
        }
      }
    }
  });

  // -- CSRF-Schutz ----------------------------------------------------------
  //
  // Verfahren: Double Submit, aber der Client erhält den Token über den
  // Antwortkörper von GET /api/v1/auth/csrf – nicht aus dem Cookie.
  //
  // Warum nicht aus dem Cookie: Frontend und API liegen auf verschiedenen
  // Hosts. Ein Browser lässt `document.cookie` ausschließlich Cookies des
  // eigenen Hosts lesen, niemals die eines anderen. Das Cookie der API ist
  // für die Frontend-Seite also unsichtbar, der Header bliebe leer und jede
  // schreibende Anfrage scheiterte mit 403.
  //
  // Warum das weiterhin schützt:
  //  - Den Token kann nur eine Seite lesen, deren Origin in der CORS-Liste
  //    steht. Eine fremde Seite erhält die Antwort vom Browser nicht.
  //  - Einen eigenen Header kann eine fremde Seite nicht cross-origin setzen,
  //    ohne einen Preflight auszulösen, den CORS für sie ablehnt.
  //  - Das Cookie allein genügt nicht: es ist HttpOnly, also für Skripte
  //    unlesbar, und der Vergleich verlangt beide Hälften.
  //
  // Zusätzlich wird die Origin geprüft. Das fängt Fehlkonfigurationen und
  // Angriffe ab, bei denen ein Token auf anderem Weg bekannt würde.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method) || isCsrfExempt(request)) return;

    // 1. Origin-Prüfung. Browser setzen Origin bei allen schreibenden
    //    Anfragen; fehlt sie, stammt die Anfrage nicht aus einem Browser und
    //    wird über den Token geprüft.
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== 'null') {
      if (!config.server.allowedOrigins.includes(origin)) {
        throw new ApiError(
          'forbidden',
          'Diese Anfrage kommt von einer nicht zugelassenen Adresse.',
        );
      }
    }

    // 2. Token-Vergleich in konstanter Zeit.
    const cookieValue = request.cookies[config.security.csrfCookieName];
    const headerValue = request.headers[config.security.csrfHeaderName];

    if (!cookieValue || typeof headerValue !== 'string' || !safeEqual(cookieValue, headerValue)) {
      throw new ApiError(
        'forbidden',
        'CSRF-Token fehlt oder ist abgelaufen. Lade die Seite neu und versuche es erneut.',
      );
    }
  });

  /**
   * Stellt sicher, dass ein CSRF-Cookie existiert, und legt den Wert für die
   * Antwort bereit.
   *
   * Das Cookie ist HttpOnly: gelesen wird es nur serverseitig. Der Client
   * bekommt den Wert über `request.csrfToken`, den die Route
   * /api/v1/auth/csrf im Antwortkörper ausgibt.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const existing = request.cookies[config.security.csrfCookieName];

    if (existing) {
      request.csrfToken = existing;
      return;
    }

    const token = generateToken(24);
    request.csrfToken = token;

    reply.setCookie(config.security.csrfCookieName, token, {
      ...config.security.cookie,
      // Nur der Server liest dieses Cookie. Es für Skripte lesbar zu machen
      // hätte keinen Nutzen und wäre bei einer XSS-Lücke zusätzlicher Schaden.
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 7,
    });
  });

  // -- Wartungsmodus --------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!config.features.maintenanceMode) return;
    if (SAFE_METHODS.has(request.method)) return;
    if (request.viewer?.isAdmin) return;
    throw new ApiError(
      'maintenance',
      'Die Plattform befindet sich im Wartungsmodus. Schreibzugriffe sind vorübergehend deaktiviert.',
    );
  });

  // -- Guards ---------------------------------------------------------------
  app.decorate('requireAuth', (request: FastifyRequest) => {
    if (!request.viewer) throw unauthenticated();
  });

  app.decorate('requireAdmin', (request: FastifyRequest) => {
    if (!request.viewer) throw unauthenticated();
    if (!request.viewer.isAdmin) throw forbidden('Diese Seite ist Administratoren vorbehalten.');
  });
});

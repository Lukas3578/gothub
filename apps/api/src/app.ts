/**
 * Zusammenbau der Fastify-Anwendung.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@forge/shared';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { GitError } from './git/exec.js';
import { contextPlugin } from './middleware/context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerGitDataRoutes } from './routes/git-data.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerPullRequestRoutes } from './routes/pull-requests.js';
import { registerBranchProtectionRoutes } from './routes/branch-protection.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerRunnerRoutes } from './routes/runner.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerInternalHookRoutes } from './routes/internal-hooks.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerWikiRoutes } from './routes/wiki.js';
import { registerGistRoutes } from './routes/gists.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerNpmRegistryRoutes } from './routes/npm-registry.js';
import { registerMirrorRoutes } from './routes/mirrors.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerGitHttpRoutes } from './git/http.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: config.isProduction ? 'info' : 'debug',
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
    // Git-Pushes können groß sein; das Limit gilt für JSON-Bodies, die
    // Git-Routen umgehen den Body-Parser ohnehin.
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: config.isProduction,
    // Erlaubt URLs wie /api/v1/repos/:owner/:repo/compare/a...b
    ignoreTrailingSlash: true,
  });

  // -- Sicherheitsheader ----------------------------------------------------
  await app.register(helmet, {
    // Die API liefert kein HTML aus; eine restriktive CSP ist trotzdem
    // sinnvoll für Fehlerseiten und Rohdateien.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    /**
     * Feste Liste erlaubter Origins. Kein Platzhalter und keine Ableitung aus
     * dem Origin-Header der Anfrage: mit `credentials: true` wäre beides
     * gleichbedeutend damit, jeder fremden Seite Zugriff auf angemeldete
     * Sitzungen zu geben.
     */
    origin: config.server.allowedOrigins,
    // Notwendig, damit Session- und CSRF-Cookie mitgesendet werden.
    credentials: true,
    allowedHeaders: ['content-type', config.security.csrfHeaderName, 'authorization'],
    // Der Browser darf das Preflight-Ergebnis zwischenspeichern; ohne das
    // bekäme jede schreibende Anfrage einen zusätzlichen Roundtrip.
    maxAge: 86_400,
  });

  await app.register(cookie, {
    secret: config.security.sessionSecret,
    parseOptions: { path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalPerMinute,
    timeWindow: '1 minute',
    // Git-Operationen zählen nicht gegen das API-Limit: ein großer Klon
    // besteht aus wenigen, aber langen Anfragen.
    allowList: (request) => request.url.startsWith('/git/'),
    keyGenerator: (request) => request.viewer?.id ?? request.ip,
    errorResponseBuilder: () => ({
      error: { code: 'rate_limited', message: 'Zu viele Anfragen. Bitte kurz warten.' },
    }),
  });

  await app.register(contextPlugin);

  // Dateiuploads kommen als roher Byte-Strom. Der Parser reicht die Anfrage
  // unverändert durch, damit sie gestreamt und nicht in den Speicher gelesen
  // wird – eine 500-MB-Datei würde den Prozess sonst umbringen.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  // -- Fehlerbehandlung -----------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      };
      return reply.code(error.statusCode).send(body);
    }

    // Schreibende Routen fangen GitError selbst ab und übersetzen ihn in eine
    // aussagekräftige Meldung. Kommt ein GitError bis hierher, stammt er aus
    // einem Lesezugriff auf ein nicht vorhandenes Objekt – etwa eine Datei, die
    // in diesem Commit nicht existiert.
    if (error instanceof GitError) {
      request.log.debug({ err: error }, 'Git-Objekt nicht gefunden');
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'Diese Datei oder Referenz existiert in diesem Stand nicht.',
        },
      });
    }

    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || '_';
        (fieldErrors[key] ??= []).push(issue.message);
      }
      const body: ApiErrorBody = {
        error: {
          code: 'validation_failed',
          message: 'Die Eingaben sind ungültig.',
          fieldErrors,
        },
      };
      return reply.code(422).send(body);
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Zu viele Anfragen. Bitte kurz warten.' },
      });
    }

    // Unerwarteter Fehler: vollständig protokollieren, dem Client aber nur
    // eine allgemeine Meldung geben.
    request.log.error({ err: error }, 'Unbehandelter Fehler');
    const body: ApiErrorBody = {
      error: { code: 'internal_error', message: 'Interner Serverfehler.' },
    };
    return reply.code(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `Kein Endpunkt für ${request.method} ${request.url}.` },
    });
  });

  // -- Routen ---------------------------------------------------------------
  app.get('/health', async () => ({
    status: 'ok',
    brand: config.brand.name,
    version: '0.1.0',
    time: new Date().toISOString(),
  }));

  app.get('/api/v1/meta', async () => ({
    brand: config.brand,
    allowRegistration: config.features.allowRegistration,
    maintenanceMode: config.features.maintenanceMode,
    gitHttpBase: `${config.server.publicApiUrl}/git`,
    /**
     * Die wirksamen Adressen. Hilft bei der Fehlersuche nach einem
     * Deployment: stimmt `webUrl` nicht mit der Adresse im Browser überein,
     * lehnt CORS die Anfragen des Frontends ab.
     */
    deployment: {
      apiUrl: config.server.publicApiUrl,
      webUrl: config.server.publicWebUrl,
      crossSite: config.server.isCrossSite,
      cookieSameSite: config.security.cookie.sameSite,
      cookieSecure: config.security.cookie.secure,
    },
  }));

  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerRepositoryRoutes(app);
  await registerGitDataRoutes(app);
  await registerIssueRoutes(app);
  await registerPullRequestRoutes(app);
  await registerBranchProtectionRoutes(app);
  await registerOrganizationRoutes(app);
  await registerReleaseRoutes(app);
  await registerSearchRoutes(app);
  await registerWorkflowRoutes(app);
  await registerRunnerRoutes(app);
  await registerAdminRoutes(app);
  await registerInternalHookRoutes(app);
  await registerNotificationRoutes(app);
  await registerMediaRoutes(app);
  await registerWikiRoutes(app);
  await registerGistRoutes(app);
  await registerProjectRoutes(app);
  await registerNpmRegistryRoutes(app);
  await registerMirrorRoutes(app);
  await registerDashboardRoutes(app);
  await registerGitHttpRoutes(app);

  return app;
}

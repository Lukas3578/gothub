/**
 * Webhooks.
 *
 * Die Zustellung läuft im Hintergrund: der auslösende Request wartet nicht
 * darauf, dass ein fremder Server antwortet. Fehlgeschlagene Zustellungen
 * werden mit wachsendem Abstand wiederholt und nach mehreren Fehlschlägen in
 * Folge wird der Hook deaktiviert, damit ein dauerhaft toter Endpunkt nicht
 * endlos Last erzeugt.
 *
 * Sicherheit: die Ziel-URL kommt vom Benutzer. Ohne Prüfung wäre das eine
 * SSRF-Lücke – ein Hook auf http://169.254.169.254/ würde Cloud-Metadaten
 * abrufen, einer auf einen internen Dienst ihn von innen erreichbar machen.
 * Deshalb wird die aufgelöste IP-Adresse geprüft, nicht nur der Hostname.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { namespaces, repositories, webhookDeliveries, webhooks } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { validationFailed } from '../lib/errors.js';
import { config } from '../config.js';

/** Hooks, die so oft hintereinander fehlschlugen, werden abgeschaltet. */
const MAX_CONSECUTIVE_FAILURES = 20;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Zieladresse prüfen
// ---------------------------------------------------------------------------

/**
 * Prüft, ob eine IP-Adresse in einem Bereich liegt, der nicht erreichbar sein
 * darf: Loopback, private Netze, link-local (inklusive der Cloud-Metadaten-
 * Adresse) und die IPv6-Entsprechungen.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];

    if (a === 0) return true; // "dieses Netz"
    if (a === 10) return true; // privat
    if (a === 127) return true; // Loopback
    if (a === 169 && b === 254) return true; // link-local, Cloud-Metadaten
    if (a === 172 && b >= 16 && b <= 31) return true; // privat
    if (a === 192 && b === 168) return true; // privat
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-Grade NAT
    if (a >= 224) return true; // Multicast und reserviert
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('ff')) return true; // Multicast
    // IPv4-gemappte Adressen auf die IPv4-Regeln zurückführen.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
  }

  return true;
}

/**
 * Validiert eine Webhook-URL.
 *
 * In der Entwicklung sind lokale Adressen erlaubt – sonst ließe sich kein
 * Hook gegen einen Testserver auf dem eigenen Rechner einrichten.
 */
export async function assertDeliverableUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw validationFailed('Die URL ist ungültig.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationFailed('Nur http und https sind erlaubt.');
  }

  if (!config.isProduction) return;

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true }).catch(() => []);

  if (addresses.length === 0) {
    throw validationFailed('Der Hostname konnte nicht aufgelöst werden.');
  }

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw validationFailed(
        'Diese Adresse liegt in einem internen Netzbereich und ist als Ziel nicht zulässig.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Signatur
// ---------------------------------------------------------------------------

/**
 * Signiert den Rumpf mit HMAC-SHA256.
 * Der Empfänger prüft damit, dass die Nachricht wirklich von dieser Instanz
 * stammt und unterwegs nicht verändert wurde.
 */
export function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = signPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Zustellung
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  event: string;
  repositoryId: string;
  payload: Record<string, unknown>;
}

/**
 * Stößt die Zustellung an alle passenden Hooks an.
 *
 * Gibt sofort zurück; die eigentlichen Anfragen laufen danach weiter. Der
 * Aufrufer soll nicht darauf warten, ob ein fremder Server erreichbar ist.
 */
export async function dispatchWebhook(event: WebhookEvent): Promise<void> {
  const repoRows = await db
    .select({
      repository: repositories,
      ownerName: namespaces.name,
    })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .where(eq(repositories.id, event.repositoryId))
    .limit(1);

  const repoRow = repoRows[0];
  if (!repoRow) return;

  // Hooks des Repositories und, falls es einer Organisation gehört, auch
  // deren übergreifende Hooks.
  const hooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.repositoryId, event.repositoryId), eq(webhooks.isActive, true)));

  if (hooks.length === 0) return;

  const body = JSON.stringify({
    event: event.event,
    deliveredAt: new Date().toISOString(),
    repository: {
      id: repoRow.repository.id,
      fullName: `${repoRow.ownerName}/${repoRow.repository.name}`,
      visibility: repoRow.repository.visibility,
      defaultBranch: repoRow.repository.defaultBranch,
    },
    ...event.payload,
  });

  for (const hook of hooks) {
    if (!hook.events.includes(event.event)) continue;
    void deliverWithRetry(hook, event.event, body);
  }
}

async function deliverWithRetry(
  hook: typeof webhooks.$inferSelect,
  event: string,
  body: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await deliverOnce(hook, event, body, attempt);

    if (result.ok) {
      await db
        .update(webhooks)
        .set({ consecutiveFailures: 0 })
        .where(eq(webhooks.id, hook.id));
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      // Wachsender Abstand: 2, 8, 32 Sekunden. Ein kurz überlasteter
      // Empfänger bekommt dadurch Zeit, ohne dass die Zustellung ewig dauert.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 2000 * 4 ** (attempt - 1)));
    }
  }

  const updated = await db
    .update(webhooks)
    .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
    .where(eq(webhooks.id, hook.id))
    .returning({ failures: webhooks.consecutiveFailures });

  if ((updated[0]?.failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    await db.update(webhooks).set({ isActive: false }).where(eq(webhooks.id, hook.id));
  }
}

async function deliverOnce(
  hook: typeof webhooks.$inferSelect,
  event: string,
  body: string,
  attempt: number,
): Promise<{ ok: boolean }> {
  const started = Date.now();
  const headers: Record<string, string> = {
    'content-type': hook.contentType,
    'user-agent': `${config.brand.name}-Webhook`,
    'x-forge-event': event,
    'x-forge-delivery-attempt': String(attempt),
  };

  if (hook.secretEnc) {
    try {
      headers['x-forge-signature-256'] = signPayload(decryptSecret(hook.secretEnc), body);
    } catch {
      // Ein nicht entschlüsselbares Geheimnis darf die Zustellung nicht
      // verhindern; der Empfänger erkennt die fehlende Signatur.
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      // Weiterleitungen werden nicht verfolgt: sonst ließe sich die
      // Adressprüfung über eine Umleitung auf eine interne Adresse umgehen.
      redirect: 'manual',
    });

    const responseText = (await response.text().catch(() => '')).slice(0, 4000);

    await db.insert(webhookDeliveries).values({
      webhookId: hook.id,
      event,
      requestBody: body.slice(0, 100_000),
      responseStatus: response.status,
      responseBody: responseText,
      durationMs: Date.now() - started,
      attempt,
    });

    return { ok: response.status >= 200 && response.status < 300 };
  } catch (error) {
    await db.insert(webhookDeliveries).values({
      webhookId: hook.id,
      event,
      requestBody: body.slice(0, 100_000),
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 1000) : 'Unbekannter Fehler',
      attempt,
    });
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export { encryptSecret };

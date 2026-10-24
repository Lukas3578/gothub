/**
 * npm-kompatible Paket-Registry.
 *
 * Genug vom npm-Protokoll, damit `npm install`, `npm publish` und
 * `npm dist-tag` gegen Forge funktionieren:
 *
 *   GET  /npm/:paket                      Metadaten (packument)
 *   GET  /npm/:paket/-/:datei             Tarball
 *   PUT  /npm/:paket                      Veröffentlichen
 *   GET  /npm/-/package/:paket/dist-tags  Tags lesen
 *   PUT  /npm/-/package/:paket/dist-tags/:tag
 *
 * Scoped-Pakete (`@org/name`) kommen URL-kodiert als `@org%2fname` an;
 * Fastify dekodiert das, sodass der Name mit Schrägstrich ankommt. Die Routen
 * nehmen den Rest des Pfades deshalb als Wildcard entgegen.
 *
 * Die Zuordnung zum Namensraum: `@scope/name` gehört dem Benutzer oder der
 * Organisation `scope`. Ein Paket ohne Scope gehört dem Veröffentlichenden.
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { auditLogs, namespaces, packageVersions, packages, users } from '../db/schema.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { objectPath, storeBuffer } from '../services/storage-objects.js';
import { getOwnableNamespaceIds } from '../services/permissions.js';

/** Obergrenze für einen Tarball. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/**
 * Prüft einen npm-Paketnamen.
 *
 * Bewusst strenger als npm selbst: keine Großbuchstaben, keine Punkte am
 * Anfang, kein Pfadtrenner außer dem einen zwischen Scope und Name.
 */
function parsePackageName(raw: string): { scope: string | null; name: string; full: string } {
  const value = raw.trim();

  const scoped = /^@([a-z0-9][a-z0-9._-]{0,38})\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(value);
  if (scoped) {
    return { scope: scoped[1]!, name: scoped[2]!, full: value };
  }

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw validationFailed(`Ungültiger Paketname: ${raw}`);
  }
  return { scope: null, name: value, full: value };
}

/** Prüft eine Version grob auf semver-Form. */
function validateVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
    throw validationFailed(`Ungültige Version: ${version}`);
  }
  return version;
}

export async function registerNpmRegistryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Die Registry authentifiziert ausschließlich über Bearer-Token.
   * `npm login` schreibt das Token in die .npmrc; Cookies spielen hier keine
   * Rolle, weshalb diese Routen auch vom CSRF-Schutz ausgenommen sind.
   */
  function requireToken(request: Parameters<typeof app.requireAuth>[0]) {
    if (!request.viewer || request.authMethod !== 'token') {
      throw forbidden(
        'Für die Registry wird ein Zugriffstoken gebraucht. Lege es unter Einstellungen → Zugriffstokens an und trage es in die .npmrc ein.',
      );
    }
    return request.viewer;
  }

  async function findPackage(full: string) {
    const parsed = parsePackageName(full);

    const rows = await db
      .select({ pkg: packages, ownerName: namespaces.name })
      .from(packages)
      .innerJoin(namespaces, eq(namespaces.id, packages.ownerNamespaceId))
      .where(and(eq(packages.format, 'npm'), eq(packages.name, parsed.full)))
      .limit(1);

    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Metadaten
  // -------------------------------------------------------------------------
  app.get<{ Params: { '*': string } }>('/npm/*', async (request, reply) => {
    const path = request.params['*'] ?? '';

    // Tarball-Anfragen haben die Form <paket>/-/<datei>.tgz
    const tarballMatch = /^(.+)\/-\/(.+)$/.exec(path);
    if (tarballMatch) {
      return serveTarball(tarballMatch[1]!, tarballMatch[2]!, reply);
    }

    // dist-tags lesen
    const distTagsMatch = /^-\/package\/(.+)\/dist-tags$/.exec(path);
    if (distTagsMatch) {
      const record = await findPackage(decodeURIComponent(distTagsMatch[1]!));
      if (!record) throw notFound('Paket nicht gefunden.');
      return readDistTags(record.pkg.id);
    }

    const record = await findPackage(path);
    if (!record) throw notFound('Paket nicht gefunden.');

    if (record.pkg.visibility !== 'public') {
      // Private Pakete verlangen ein Token mit Zugriff auf den Namensraum.
      const viewer = request.viewer;
      if (!viewer) throw notFound('Paket nicht gefunden.');
      const ownable = await getOwnableNamespaceIds(viewer.id);
      if (!ownable.includes(record.pkg.ownerNamespaceId) && !viewer.isAdmin) {
        throw notFound('Paket nicht gefunden.');
      }
    }

    const versionRows = await db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, record.pkg.id))
      .orderBy(desc(packageVersions.createdAt));

    const versions: Record<string, unknown> = {};
    for (const row of versionRows) {
      if (row.yankedAt) continue;
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      versions[row.version] = {
        ...metadata,
        name: record.pkg.name,
        version: row.version,
        dist: {
          tarball: `${config.server.publicApiUrl}/npm/${record.pkg.name}/-/${encodeURIComponent(
            `${record.pkg.name.replace(/^@[^/]+\//, '')}-${row.version}.tgz`,
          )}`,
          shasum: (metadata.shasum as string | undefined) ?? '',
          integrity: `sha256-${Buffer.from(row.sha256 ?? '', 'hex').toString('base64')}`,
        },
      };
    }

    return {
      _id: record.pkg.name,
      name: record.pkg.name,
      description: record.pkg.description ?? '',
      'dist-tags': await readDistTags(record.pkg.id),
      versions,
      time: Object.fromEntries(
        versionRows.map((row) => [row.version, row.createdAt.toISOString()]),
      ),
    };
  });

  /** dist-tags liegen in den Metadaten des Pakets, nicht in einer eigenen Tabelle. */
  async function readDistTags(packageId: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ version: packageVersions.version, metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.createdAt));

    const tags: Record<string, string> = {};
    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      for (const tag of (metadata._distTags as string[] | undefined) ?? []) {
        // Neuere Versionen stehen vorn; der erste Treffer gewinnt.
        if (!tags[tag]) tags[tag] = row.version;
      }
    }
    if (!tags.latest && rows[0]) tags.latest = rows[0].version;
    return tags;
  }

  async function serveTarball(packageName: string, filename: string, reply: any) {
    const record = await findPackage(decodeURIComponent(packageName));
    if (!record) throw notFound('Paket nicht gefunden.');

    // Die Version steckt im Dateinamen: <name>-<version>.tgz
    const match = /-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)\.tgz$/.exec(
      decodeURIComponent(filename),
    );
    if (!match) throw notFound('Datei nicht gefunden.');

    const [version] = await db
      .select()
      .from(packageVersions)
      .where(
        and(eq(packageVersions.packageId, record.pkg.id), eq(packageVersions.version, match[1]!)),
      )
      .limit(1);

    if (!version) throw notFound('Version nicht gefunden.');

    const buffer = await readFile(objectPath(version.storageKey));

    await db
      .update(packageVersions)
      .set({ downloadCount: version.downloadCount + 1 })
      .where(eq(packageVersions.id, version.id));

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  }

  // -------------------------------------------------------------------------
  // Veröffentlichen
  // -------------------------------------------------------------------------
  /**
   * Der npm-Client schickt mehr Felder, als hier gebraucht werden, und setzt
   * nicht belegte Werte auf `null` statt sie wegzulassen. Alle optionalen
   * Felder sind deshalb `nullish`; unbekannte Felder werden verworfen.
   */
  const publishSchema = z.object({
    name: z.string().min(1).max(214),
    description: z.string().max(500).nullish(),
    'dist-tags': z.record(z.string()).nullish(),
    versions: z.record(z.record(z.unknown())),
    _attachments: z
      .record(z.object({ data: z.string(), content_type: z.string().nullish() }))
      .nullish(),
    access: z.enum(['public', 'restricted']).nullish(),
  });

  app.put<{ Params: { '*': string } }>('/npm/*', async (request, reply) => {
    const path = request.params['*'] ?? '';

    // dist-tag setzen
    const tagMatch = /^-\/package\/(.+)\/dist-tags\/(.+)$/.exec(path);
    if (tagMatch) {
      const viewer = requireToken(request);
      const record = await findPackage(decodeURIComponent(tagMatch[1]!));
      if (!record) throw notFound('Paket nicht gefunden.');

      const ownable = await getOwnableNamespaceIds(viewer.id);
      if (!ownable.includes(record.pkg.ownerNamespaceId) && !viewer.isAdmin) {
        throw forbidden('Du darfst dieses Paket nicht ändern.');
      }

      const version = String(request.body).replace(/"/g, '');
      const [row] = await db
        .select()
        .from(packageVersions)
        .where(
          and(eq(packageVersions.packageId, record.pkg.id), eq(packageVersions.version, version)),
        )
        .limit(1);
      if (!row) throw notFound('Version nicht gefunden.');

      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const tags = new Set([...((metadata._distTags as string[] | undefined) ?? []), tagMatch[2]!]);

      await db
        .update(packageVersions)
        .set({ metadata: { ...metadata, _distTags: [...tags] } })
        .where(eq(packageVersions.id, row.id));

      return { ok: true };
    }

    // Veröffentlichen
    const viewer = requireToken(request);
    const body = publishSchema.parse(request.body);
    const parsed = parsePackageName(body.name);

    // Namensraum bestimmen: Scope → gleichnamiger Benutzer oder Organisation.
    let ownerNamespaceId: string;
    if (parsed.scope) {
      const [namespace] = await db
        .select()
        .from(namespaces)
        .where(eq(namespaces.nameLower, parsed.scope))
        .limit(1);
      if (!namespace) {
        throw validationFailed(
          `Für den Scope "@${parsed.scope}" gibt es weder einen Benutzer noch eine Organisation.`,
        );
      }

      const ownable = await getOwnableNamespaceIds(viewer.id);
      if (!ownable.includes(namespace.id) && !viewer.isAdmin) {
        throw forbidden(`Du darfst nicht unter "@${parsed.scope}" veröffentlichen.`);
      }
      ownerNamespaceId = namespace.id;
    } else {
      const [own] = await db
        .select({ namespaceId: users.namespaceId })
        .from(users)
        .where(eq(users.id, viewer.id))
        .limit(1);
      ownerNamespaceId = own!.namespaceId;
    }

    const existing = await findPackage(parsed.full);
    if (existing && existing.pkg.ownerNamespaceId !== ownerNamespaceId) {
      throw forbidden('Dieser Paketname ist bereits von einem anderen Namensraum belegt.');
    }

    const packageId =
      existing?.pkg.id ??
      (
        await db
          .insert(packages)
          .values({
            ownerNamespaceId,
            format: 'npm',
            name: parsed.full,
            description: body.description ?? null,
            visibility: body.access === 'restricted' ? 'private' : 'public',
          })
          .returning()
      )[0]!.id;

    const results: string[] = [];

    for (const [version, manifest] of Object.entries(body.versions)) {
      validateVersion(version);

      const [duplicate] = await db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(
          and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)),
        )
        .limit(1);

      if (duplicate) {
        // npm selbst lehnt das Überschreiben ab; eine stille Annahme wäre
        // gefährlich, weil sie bereits installierte Stände verändern könnte.
        throw validationFailed(
          `Version ${version} von ${parsed.full} ist bereits veröffentlicht und kann nicht ersetzt werden.`,
        );
      }

      // Der Tarball liegt base64-kodiert in _attachments.
      const attachmentKey = Object.keys(body._attachments ?? {}).find((key) =>
        key.includes(version),
      );
      const attachment = attachmentKey ? body._attachments![attachmentKey] : undefined;
      if (!attachment) {
        throw validationFailed(`Zu Version ${version} fehlt der Tarball.`);
      }

      const buffer = Buffer.from(attachment.data, 'base64');
      if (buffer.length > MAX_TARBALL_BYTES) {
        throw validationFailed(
          `Der Tarball von ${version} überschreitet ${MAX_TARBALL_BYTES / 1024 / 1024} MB.`,
        );
      }

      const stored = await storeBuffer('packages', buffer);
      const shasum = createHash('sha1').update(buffer).digest('hex');

      const distTags = Object.entries(body['dist-tags'] ?? {})
        .filter(([, tagged]) => tagged === version)
        .map(([tag]) => tag);

      await db.insert(packageVersions).values({
        packageId,
        version,
        storageKey: stored.storageKey,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        metadata: { ...manifest, shasum, _distTags: distTags.length > 0 ? distTags : ['latest'] },
        publishedById: viewer.id,
      });

      results.push(version);
    }

    await db.insert(auditLogs).values({
      actorId: viewer.id,
      action: 'package.published',
      targetType: 'package',
      targetId: packageId,
      metadata: { name: parsed.full, versions: results },
    });

    reply.code(201);
    return { ok: true, id: parsed.full, versions: results };
  });

  // -------------------------------------------------------------------------
  // Übersicht in der Oberfläche
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string } }>('/api/v1/users/:owner/packages', async (request) => {
    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.nameLower, request.params.owner.toLowerCase()))
      .limit(1);
    if (!namespace) throw notFound('Besitzer nicht gefunden.');

    const canSeePrivate = request.viewer
      ? (await getOwnableNamespaceIds(request.viewer.id)).includes(namespace.id) ||
        request.viewer.isAdmin
      : false;

    const rows = await db
      .select()
      .from(packages)
      .where(eq(packages.ownerNamespaceId, namespace.id))
      .orderBy(packages.name);

    const visible = canSeePrivate ? rows : rows.filter((row) => row.visibility === 'public');

    const items = await Promise.all(
      visible.map(async (row) => {
        const versions = await db
          .select({
            version: packageVersions.version,
            createdAt: packageVersions.createdAt,
            downloadCount: packageVersions.downloadCount,
            sizeBytes: packageVersions.sizeBytes,
          })
          .from(packageVersions)
          .where(eq(packageVersions.packageId, row.id))
          .orderBy(desc(packageVersions.createdAt))
          .limit(10);

        return {
          id: row.id,
          format: row.format,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          createdAt: row.createdAt.toISOString(),
          versions: versions.map((entry) => ({
            version: entry.version,
            createdAt: entry.createdAt.toISOString(),
            downloadCount: entry.downloadCount,
            sizeBytes: entry.sizeBytes,
          })),
          installCommand: `npm install ${row.name} --registry ${config.server.publicApiUrl}/npm`,
        };
      }),
    );

    return { items };
  });
}

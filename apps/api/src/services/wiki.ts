/**
 * Wiki.
 *
 * Jede Seite ist eine Markdown-Datei im Wiki-Repository des Projekts. Damit
 * gilt für Wikis dasselbe wie für den Quelltext: echte Historie, echte Diffs,
 * klonbar, und keine zweite Speicherform, die mit Git auseinanderlaufen kann.
 *
 * Seitennamen werden in Dateinamen übersetzt (`Erste Schritte` →
 * `Erste-Schritte.md`). Die Übersetzung ist umkehrbar, damit der angezeigte
 * Titel nicht separat gespeichert werden muss.
 */

import type { CommitSummary } from '@forge/shared';
import { runGit, runGitText } from '../git/exec.js';
import { ensureWikiRepository, wikiExists, wikiPath } from '../git/storage.js';
import { notFound, validationFailed } from '../lib/errors.js';

export interface WikiPageSummary {
  slug: string;
  title: string;
  path: string;
  sizeBytes: number;
  updatedAt: string | null;
  lastCommit: CommitSummary | null;
}

export interface WikiPageDetail extends WikiPageSummary {
  content: string;
}

const FIELD = '\u0001';
const RECORD = '\u0002';

const COMMIT_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join(
  FIELD,
);

function parseCommit(record: string): CommitSummary | null {
  const parts = record.split(FIELD);
  if (parts.length < 11 || !parts[0]) return null;
  return {
    oid: parts[0]!,
    shortOid: parts[1]!,
    parents: parts[2] ? parts[2].split(' ').filter(Boolean) : [],
    author: { name: parts[3]!, email: parts[4]!, date: parts[5]!, user: null },
    committer: { name: parts[6]!, email: parts[7]!, date: parts[8]!, user: null },
    subject: parts[9]!,
    body: (parts[10] ?? '').trim(),
  };
}

/**
 * Wandelt einen Seitentitel in einen Dateinamen.
 *
 * Verbotene Zeichen werden entfernt statt ersetzt, damit zwei verschiedene
 * Titel nicht zufällig auf dieselbe Datei zeigen. Ein Titel, von dem nichts
 * übrig bleibt, wird abgewiesen.
 */
export function slugify(title: string): string {
  const slug = title
    .trim()
    .replace(/\s+/g, '-')
    // Pfadtrenner, Steuerzeichen und alles, was Git-Referenzen stört.
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 100);

  if (!slug) {
    throw validationFailed('Aus diesem Titel lässt sich kein Seitenname bilden.');
  }
  return slug;
}

/** Macht die Umwandlung für die Anzeige rückgängig. */
export function titleFromSlug(slug: string): string {
  return slug.replace(/-/g, ' ');
}

function fileFor(slug: string): string {
  return `${slug}.md`;
}

/** Listet alle Seiten des Wikis. */
export async function listPages(repositoryId: string): Promise<WikiPageSummary[]> {
  if (!(await wikiExists(repositoryId))) return [];

  const cwd = wikiPath(repositoryId);

  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  if (head.exitCode !== 0) return [];

  const output = await runGitText(['ls-tree', '-z', '--long', 'HEAD'], { cwd });

  const pages: WikiPageSummary[] = [];

  for (const line of output.split('\0')) {
    if (!line) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;

    const meta = line.slice(0, tabIndex).split(/\s+/);
    const name = line.slice(tabIndex + 1);
    if (meta[1] !== 'blob' || !name.endsWith('.md')) continue;

    const slug = name.slice(0, -3);
    const sizeRaw = meta[3];

    // Der letzte Commit je Seite kostet einen Aufruf; bei der überschaubaren
    // Seitenzahl eines Wikis ist das vertretbar und macht die Liste nützlich.
    const commitOutput = await runGitText(
      ['log', '-1', `--pretty=format:${COMMIT_FORMAT}`, 'HEAD', '--', name],
      { cwd, maxBuffer: 64 * 1024 },
    ).catch(() => '');

    const lastCommit = commitOutput ? parseCommit(commitOutput) : null;

    pages.push({
      slug,
      title: titleFromSlug(slug),
      path: name,
      sizeBytes: sizeRaw && sizeRaw !== '-' ? Number(sizeRaw) : 0,
      updatedAt: lastCommit?.committer.date ?? null,
      lastCommit,
    });
  }

  pages.sort((a, b) => a.title.localeCompare(b.title, 'de'));
  return pages;
}

export async function readPage(
  repositoryId: string,
  slug: string,
  ref = 'HEAD',
): Promise<WikiPageDetail> {
  if (!(await wikiExists(repositoryId))) throw notFound('Dieses Wiki ist noch leer.');

  const cwd = wikiPath(repositoryId);
  const file = fileFor(slugify(slug));

  const result = await runGit(['cat-file', 'blob', `${ref}:${file}`], {
    cwd,
    allowFailure: true,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.exitCode !== 0) throw notFound(`Die Seite "${titleFromSlug(slug)}" existiert nicht.`);

  const commitOutput = await runGitText(
    ['log', '-1', `--pretty=format:${COMMIT_FORMAT}`, ref, '--', file],
    { cwd, maxBuffer: 64 * 1024 },
  ).catch(() => '');

  const lastCommit = commitOutput ? parseCommit(commitOutput) : null;
  const content = result.stdout.toString('utf8');

  return {
    slug: slugify(slug),
    title: titleFromSlug(slugify(slug)),
    path: file,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    updatedAt: lastCommit?.committer.date ?? null,
    lastCommit,
    content,
  };
}

/**
 * Legt eine Seite an oder überschreibt sie.
 *
 * Arbeitet wie der Dateibrowser über die Git-Plumbing-Kommandos, ohne
 * Arbeitsverzeichnis; `expectedOid` verhindert, dass zwei gleichzeitige
 * Bearbeitungen sich gegenseitig überschreiben.
 */
export async function writePage(
  repositoryId: string,
  options: {
    slug: string;
    content: string;
    message?: string;
    author: { name: string; email: string };
    expectedOid?: string | null;
  },
): Promise<string> {
  await ensureWikiRepository(repositoryId);

  const cwd = wikiPath(repositoryId);
  const slug = slugify(options.slug);
  const file = fileFor(slug);

  const headResult = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
    cwd,
    allowFailure: true,
  });
  const parentOid = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : null;

  if (options.expectedOid !== undefined && options.expectedOid !== null) {
    if (parentOid !== options.expectedOid) {
      throw validationFailed(
        'Die Seite wurde zwischenzeitlich geändert. Lade sie neu und übertrage deine Änderung erneut.',
      );
    }
  }

  const indexFile = `${cwd}/index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    await runGit(parentOid ? ['read-tree', parentOid] : ['read-tree', '--empty'], { cwd, env });

    const blobOid = (
      await runGit(['hash-object', '-w', '--stdin'], {
        cwd,
        input: Buffer.from(options.content, 'utf8'),
      })
    ).stdout
      .toString('utf8')
      .trim();

    await runGit(['update-index', '--add', '--cacheinfo', `100644,${blobOid},${file}`], {
      cwd,
      env,
    });

    const treeOid = (await runGitText(['write-tree'], { cwd, env })).trim();

    const message = options.message?.trim() || `Seite "${titleFromSlug(slug)}" aktualisiert`;
    const commitArgs = ['commit-tree', treeOid, '-m', message];
    if (parentOid) commitArgs.push('-p', parentOid);

    const commitOid = (
      await runGitText(commitArgs, {
        cwd,
        env: {
          GIT_INDEX_FILE: indexFile,
          GIT_AUTHOR_NAME: options.author.name,
          GIT_AUTHOR_EMAIL: options.author.email,
          GIT_COMMITTER_NAME: options.author.name,
          GIT_COMMITTER_EMAIL: options.author.email,
        },
      })
    ).trim();

    const updateArgs = ['update-ref', 'refs/heads/main', commitOid];
    updateArgs.push(parentOid ?? '');
    await runGit(updateArgs, { cwd });

    return commitOid;
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(indexFile).catch(() => {});
  }
}

export async function deletePage(
  repositoryId: string,
  slug: string,
  author: { name: string; email: string },
): Promise<string> {
  if (!(await wikiExists(repositoryId))) throw notFound('Dieses Wiki ist noch leer.');

  const cwd = wikiPath(repositoryId);
  const file = fileFor(slugify(slug));

  const headResult = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
    cwd,
    allowFailure: true,
  });
  const parentOid = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : null;
  if (!parentOid) throw notFound('Dieses Wiki ist noch leer.');

  const exists = await runGit(['cat-file', '-e', `${parentOid}:${file}`], {
    cwd,
    allowFailure: true,
  });
  if (exists.exitCode !== 0) throw notFound('Diese Seite existiert nicht.');

  const indexFile = `${cwd}/index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    await runGit(['read-tree', parentOid], { cwd, env });
    // Wie im Dateibrowser: --force-remove scheidet im bare-Repository aus.
    await runGit(['update-index', '-z', '--index-info'], {
      cwd,
      env,
      input: `0 0000000000000000000000000000000000000000\t${file}\0`,
    });

    const treeOid = (await runGitText(['write-tree'], { cwd, env })).trim();

    const commitOid = (
      await runGitText(
        ['commit-tree', treeOid, '-m', `Seite "${titleFromSlug(slug)}" gelöscht`, '-p', parentOid],
        {
          cwd,
          env: {
            GIT_INDEX_FILE: indexFile,
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email,
          },
        },
      )
    ).trim();

    await runGit(['update-ref', 'refs/heads/main', commitOid, parentOid], { cwd });
    return commitOid;
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(indexFile).catch(() => {});
  }
}

/** Änderungsverlauf einer Seite oder des gesamten Wikis. */
export async function pageHistory(
  repositoryId: string,
  slug: string | null,
  limit = 30,
): Promise<CommitSummary[]> {
  if (!(await wikiExists(repositoryId))) return [];

  const cwd = wikiPath(repositoryId);
  const args = [
    'log',
    `--pretty=format:${COMMIT_FORMAT}${RECORD}`,
    `--max-count=${Math.min(limit, 100)}`,
    'HEAD',
  ];
  if (slug) args.push('--', fileFor(slugify(slug)));

  const output = await runGitText(args, { cwd, allowFailure: true }).catch(() => '');

  const commits: CommitSummary[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parsed = parseCommit(trimmed);
    if (parsed) commits.push(parsed);
  }
  return commits;
}

/** Aktueller Stand des Wikis, für die optimistische Sperre beim Bearbeiten. */
export async function currentWikiOid(repositoryId: string): Promise<string | null> {
  if (!(await wikiExists(repositoryId))) return null;
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
    cwd: wikiPath(repositoryId),
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
}

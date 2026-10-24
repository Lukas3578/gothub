/**
 * Ableitung von Repository-Metadaten aus dem Git-Inhalt:
 * Sprachverteilung, Größe und Commit-Suchindex.
 *
 * Alles hier ist abgeleitet und jederzeit neu berechenbar. Schlägt etwas fehl,
 * bleibt das Repository benutzbar – die Werte sind dann nur veraltet.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { commitIndex, repositories, users } from '../db/schema.js';
import { runGitText } from '../git/exec.js';
import { repositoryPath, repositorySize } from '../git/storage.js';
import { isEmpty, listCommits } from '../git/repository.js';
import { detectLanguage, isExcludedFromStats, primaryLanguageFrom } from '../lib/language.js';

/**
 * Berechnet die Sprachverteilung des Default-Branch.
 *
 * Zählt Bytes je Sprache über `ls-tree -r --long`. Generierte Verzeichnisse
 * und Lock-Dateien werden ausgeschlossen, sonst wäre bei jedem
 * JavaScript-Projekt node_modules die Hauptsprache.
 */
export async function computeLanguages(
  repositoryId: string,
  ref: string,
): Promise<Record<string, number>> {
  const output = await runGitText(['ls-tree', '-r', '-z', '--long', ref], {
    cwd: repositoryPath(repositoryId),
    maxBuffer: 32 * 1024 * 1024,
  });

  const distribution: Record<string, number> = {};

  for (const line of output.split('\0')) {
    if (!line) continue;

    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;

    const meta = line.slice(0, tabIndex).split(/\s+/);
    const path = line.slice(tabIndex + 1);

    const [mode, type, , sizeRaw] = meta;
    if (type !== 'blob') continue;
    // Symlinks und Submodule zählen nicht als Quelltext.
    if (mode === '120000' || mode === '160000') continue;
    if (isExcludedFromStats(path)) continue;

    const size = Number(sizeRaw);
    if (!Number.isFinite(size) || size === 0) continue;

    const language = detectLanguage(path);
    if (!language) continue;

    distribution[language] = (distribution[language] ?? 0) + size;
  }

  return distribution;
}

/**
 * Aktualisiert Sprachen, Hauptsprache und Größe eines Repositories.
 *
 * `touchPushedAt` setzt zusätzlich den Zeitpunkt der letzten Änderung. Wer
 * über die Oberfläche committet, pusht nicht – trotzdem hat sich das
 * Repository geändert. Ohne diesen Schalter stand bei einem Projekt, das nur
 * im Browser bearbeitet wurde, dauerhaft „Letzter Push: nie", und das
 * Dashboard, das danach sortiert, zeigte es nie an.
 */
export async function syncRepositoryMetadata(
  repositoryId: string,
  options: { touchPushedAt?: boolean } = {},
): Promise<void> {
  const touched = options.touchPushedAt ? { pushedAt: new Date() } : {};
  const [repo] = await db
    .select({ defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  if (!repo) return;

  const empty = await isEmpty(repositoryId);
  const sizeBytes = await repositorySize(repositoryId);

  if (empty) {
    await db
      .update(repositories)
      .set({ languages: {}, primaryLanguage: null, sizeBytes, isEmpty: true, ...touched })
      .where(eq(repositories.id, repositoryId));
    return;
  }

  const languages = await computeLanguages(repositoryId, repo.defaultBranch).catch(() => ({}));

  await db
    .update(repositories)
    .set({
      languages,
      primaryLanguage: primaryLanguageFrom(languages),
      sizeBytes,
      isEmpty: false,
      ...touched,
    })
    .where(eq(repositories.id, repositoryId));

  await indexRecentCommits(repositoryId, repo.defaultBranch).catch(() => {});
}

/**
 * Schreibt die jüngsten Commits in den Suchindex.
 *
 * Es werden bewusst nur die letzten 500 Commits indexiert: ein vollständiger
 * Index großer Repositories gehört in einen Hintergrundjob, nicht in den
 * Request-Pfad nach einem Push.
 */
export async function indexRecentCommits(
  repositoryId: string,
  ref: string,
  limit = 500,
): Promise<void> {
  const commits = await listCommits(repositoryId, { ref, limit });
  if (commits.length === 0) return;

  // E-Mails den Plattform-Accounts zuordnen, damit Commit-Suche nach Autor
  // und Contributor-Statistiken funktionieren.
  const emails = [...new Set(commits.map((c) => c.author.email.toLowerCase()))];
  const accounts = await db
    .select({ id: users.id, emailLower: users.emailLower })
    .from(users)
    .where(inArray(users.emailLower, emails));

  const byEmail = new Map(accounts.map((a) => [a.emailLower, a.id]));

  const rows = commits.map((commit) => ({
    repositoryId,
    oid: commit.oid,
    authorName: commit.author.name.slice(0, 255),
    authorEmail: commit.author.email.slice(0, 320),
    authorUserId: byEmail.get(commit.author.email.toLowerCase()) ?? null,
    committedAt: new Date(commit.committer.date),
    subject: commit.subject.slice(0, 500),
    body: commit.body || null,
  }));

  // onConflictDoNothing: bereits indexierte Commits sind unveränderlich,
  // ein erneutes Schreiben wäre reine Last.
  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insert(commitIndex)
      .values(rows.slice(i, i + 100))
      .onConflictDoNothing();
  }
}

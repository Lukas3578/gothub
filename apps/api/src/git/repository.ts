/**
 * Lesender Zugriff auf Git-Repositories.
 *
 * Alle Funktionen arbeiten gegen ein bare-Repository und rufen das echte
 * git-Binary auf. Es gibt hier keine nachgebaute Git-Implementierung und keine
 * zwischengespeicherten Commits – was zurückkommt, steht so im Repository.
 *
 * Beim Parsen wird konsequent mit Nullbyte-getrennten Ausgaben (`-z`) und
 * eindeutigen Trennzeichen gearbeitet, weil Dateinamen und Commit-Messages
 * Zeilenumbrüche, Anführungszeichen und Tabs enthalten dürfen.
 */

import type {
  BlobContent,
  BranchInfo,
  CommitDetail,
  CommitSummary,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffStats,
  DiffStatus,
  GitSignature,
  TagInfo,
  TreeEntry,
} from '@forge/shared';
import { config } from '../config.js';
import { assertNotOption, GitError, runGit, runGitText } from './exec.js';
import { repositoryPath } from './storage.js';
import { detectLanguage } from '../lib/language.js';

/** Trennzeichen für `--pretty`-Ausgaben. Kommt in Git-Metadaten nicht vor. */
const FIELD = '\u0001';
const RECORD = '\u0002';

const COMMIT_FORMAT = [
  '%H', // 0 vollständiger Hash
  '%h', // 1 kurzer Hash
  '%P', // 2 Eltern, leerzeichengetrennt
  '%an', // 3 Autor Name
  '%ae', // 4 Autor E-Mail
  '%aI', // 5 Autor Datum ISO-8601 strikt
  '%cn', // 6 Committer Name
  '%ce', // 7 Committer E-Mail
  '%cI', // 8 Committer Datum
  '%s', // 9 Subject
  '%b', // 10 Body
].join(FIELD);

function parseCommitRecord(record: string): CommitSummary | null {
  const parts = record.split(FIELD);
  if (parts.length < 11 || !parts[0]) return null;

  const signature = (name: string, email: string, date: string): GitSignature => ({
    name,
    email,
    date,
    // Die Zuordnung zu Plattform-Accounts erfolgt in einer eigenen Schicht,
    // weil sie Datenbankzugriff braucht. Hier bewusst null.
    user: null,
  });

  return {
    oid: parts[0]!,
    shortOid: parts[1]!,
    parents: parts[2]! ? parts[2]!.split(' ').filter(Boolean) : [],
    author: signature(parts[3]!, parts[4]!, parts[5]!),
    committer: signature(parts[6]!, parts[7]!, parts[8]!),
    subject: parts[9]!,
    body: (parts[10] ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** True, wenn das Repository noch keinen einzigen Commit enthält. */
export async function isEmpty(repositoryId: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: repositoryPath(repositoryId),
    allowFailure: true,
  });
  return result.exitCode !== 0;
}

/** Liest den Branch, auf den HEAD zeigt. */
export async function getHeadBranch(repositoryId: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--short', 'HEAD'], {
    cwd: repositoryPath(repositoryId),
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString('utf8').trim() || null;
}

/** Setzt den Default-Branch. Der Branch muss existieren. */
export async function setHeadBranch(repositoryId: string, branch: string): Promise<void> {
  assertNotOption(branch, 'Branch-Name');
  const cwd = repositoryPath(repositoryId);

  const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd,
    allowFailure: true,
  });
  if (exists.exitCode !== 0) {
    throw new GitError(`Branch ${branch} existiert nicht.`, 1, '');
  }

  await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd });
}

/**
 * Listet alle Branches mit ihrem letzten Commit.
 *
 * Nutzt `for-each-ref` mit einem einzigen Aufruf statt je Branch ein `log` –
 * bei Repositories mit vielen Branches ist der Unterschied erheblich.
 */
export async function listBranches(
  repositoryId: string,
  defaultBranch: string,
): Promise<BranchInfo[]> {
  const cwd = repositoryPath(repositoryId);

  const format = ['%(refname:short)', '%(objectname)', COMMIT_FORMAT.replace(/%/g, '%')].join(FIELD);

  const output = await runGitText(
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(authorname)${FIELD}%(authoremail:trim)${FIELD}%(authordate:iso-strict)${FIELD}%(committername)${FIELD}%(committeremail:trim)${FIELD}%(committerdate:iso-strict)${FIELD}%(contents:subject)${RECORD}`,
      'refs/heads/',
    ],
    { cwd },
  );

  const branches: BranchInfo[] = [];

  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parts = trimmed.split(FIELD);
    if (parts.length < 9) continue;

    const name = parts[0]!;
    const oid = parts[1]!;

    branches.push({
      name,
      oid,
      isDefault: name === defaultBranch,
      // Branch-Schutz wird von der Datenbankschicht ergänzt.
      isProtected: false,
      lastCommit: {
        oid,
        shortOid: oid.slice(0, 7),
        parents: [],
        author: { name: parts[2]!, email: parts[3]!, date: parts[4]!, user: null },
        committer: { name: parts[5]!, email: parts[6]!, date: parts[7]!, user: null },
        subject: parts[8]!,
        body: '',
      },
      aheadBehind: null,
    });
  }

  return branches;
}

/** Berechnet, wie weit ein Branch vor bzw. hinter einem anderen liegt. */
export async function aheadBehind(
  repositoryId: string,
  branch: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number } | null> {
  assertNotOption(branch, 'Branch-Name');
  assertNotOption(baseBranch, 'Basis-Branch');

  const result = await runGit(
    ['rev-list', '--left-right', '--count', `${baseBranch}...${branch}`],
    { cwd: repositoryPath(repositoryId), allowFailure: true },
  );
  if (result.exitCode !== 0) return null;

  const [behind, ahead] = result.stdout.toString('utf8').trim().split(/\s+/).map(Number);
  if (behind === undefined || ahead === undefined) return null;
  return { ahead, behind };
}

export async function listTags(repositoryId: string): Promise<TagInfo[]> {
  const cwd = repositoryPath(repositoryId);

  const output = await runGitText(
    [
      'for-each-ref',
      '--sort=-creatordate',
      `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(objecttype)${FIELD}%(*objectname)${FIELD}%(taggername)${FIELD}%(taggeremail:trim)${FIELD}%(taggerdate:iso-strict)${FIELD}%(contents:subject)${RECORD}`,
      'refs/tags/',
    ],
    { cwd },
  );

  const tags: TagInfo[] = [];

  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parts = trimmed.split(FIELD);
    if (parts.length < 8) continue;

    const isAnnotated = parts[2] === 'tag';

    tags.push({
      name: parts[0]!,
      oid: parts[1]!,
      // Bei annotierten Tags zeigt %(*objectname) auf den Commit.
      targetOid: parts[3] || parts[1]!,
      isAnnotated,
      message: isAnnotated ? parts[7]! : null,
      tagger: isAnnotated && parts[4] ? { name: parts[4]!, email: parts[5]!, date: parts[6]!, user: null } : null,
      lastCommit: null,
    });
  }

  return tags;
}

/**
 * Löst eine Referenz (Branch, Tag, SHA) in einen Commit-Hash auf.
 * Gibt null zurück, wenn die Referenz unbekannt ist.
 */
export async function resolveRef(repositoryId: string, ref: string): Promise<string | null> {
  assertNotOption(ref, 'Referenz');

  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repositoryPath(repositoryId),
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

export async function createBranch(
  repositoryId: string,
  name: string,
  fromRef: string,
): Promise<void> {
  assertNotOption(name, 'Branch-Name');
  assertNotOption(fromRef, 'Ausgangs-Referenz');

  const cwd = repositoryPath(repositoryId);

  // `git branch` prüft den Namen selbst gegen die Regeln aus
  // git-check-ref-format; eine eigene Validierung wäre fehleranfällig.
  await runGit(['branch', '--', name, fromRef], { cwd });
}

export async function deleteBranch(repositoryId: string, name: string): Promise<void> {
  assertNotOption(name, 'Branch-Name');
  await runGit(['branch', '-D', '--', name], { cwd: repositoryPath(repositoryId) });
}

// ---------------------------------------------------------------------------
// Dateibaum
// ---------------------------------------------------------------------------

/**
 * Listet den Inhalt eines Verzeichnisses.
 *
 * `-z` liefert Nullbyte-getrennte Einträge; damit sind Dateinamen mit
 * Zeilenumbrüchen oder Anführungszeichen unproblematisch.
 */
export async function listTree(
  repositoryId: string,
  ref: string,
  path: string,
): Promise<TreeEntry[]> {
  const cwd = repositoryPath(repositoryId);
  const commit = await resolveRef(repositoryId, ref);
  if (!commit) throw new GitError(`Referenz ${ref} nicht gefunden.`, 1, '');

  const normalized = normalizePath(path);
  const target = normalized ? `${commit}:${normalized}` : commit;

  const result = await runGit(['ls-tree', '-z', '--long', '--', target], {
    cwd,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new GitError(`Pfad ${normalized || '/'} nicht gefunden.`, 1, result.stderr);
  }

  const entries: TreeEntry[] = [];

  for (const line of result.stdout.toString('utf8').split('\0')) {
    if (!line) continue;

    // Format: <mode> SP <type> SP <oid> SP* <size> TAB <name>
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;

    const meta = line.slice(0, tabIndex).split(/\s+/);
    const name = line.slice(tabIndex + 1);
    const [mode, type, oid, sizeRaw] = meta;
    if (!mode || !type || !oid) continue;

    const entryPath = normalized ? `${normalized}/${name}` : name;
    const size = sizeRaw && sizeRaw !== '-' ? Number(sizeRaw) : null;

    entries.push({
      name,
      path: entryPath,
      // Modus 120000 ist ein Symlink, 160000 ein Submodul.
      type:
        mode === '120000'
          ? 'symlink'
          : type === 'commit'
            ? 'commit'
            : type === 'tree'
              ? 'tree'
              : 'blob',
      mode,
      oid,
      size,
    });
  }

  // Verzeichnisse zuerst, danach alphabetisch – entspricht der Erwartung aus
  // gängigen Code-Hostern.
  entries.sort((a, b) => {
    const aDir = a.type === 'tree' ? 0 : 1;
    const bDir = b.type === 'tree' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, 'en');
  });

  return entries;
}

/**
 * Ergänzt für jeden Eintrag den letzten Commit, der ihn verändert hat.
 *
 * Das ist die teuerste Operation des Dateibrowsers: Git kann das nicht in
 * einem Aufruf für alle Pfade liefern. Deshalb läuft je Eintrag ein
 * `log -1`, aber begrenzt parallel, damit ein Verzeichnis mit 500 Einträgen
 * den Server nicht mit 500 gleichzeitigen Prozessen belegt.
 */
export async function attachLastCommits(
  repositoryId: string,
  ref: string,
  entries: TreeEntry[],
  concurrency = 8,
): Promise<TreeEntry[]> {
  const cwd = repositoryPath(repositoryId);
  const queue = [...entries];
  const results = new Map<string, CommitSummary | null>();

  async function worker(): Promise<void> {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;

      try {
        const output = await runGitText(
          ['log', '-1', `--pretty=format:${COMMIT_FORMAT}`, ref, '--', entry.path],
          { cwd, maxBuffer: 1024 * 64 },
        );
        results.set(entry.path, output ? parseCommitRecord(output) : null);
      } catch {
        results.set(entry.path, null);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  return entries.map((entry) => ({ ...entry, lastCommit: results.get(entry.path) ?? null }));
}

/** Liest den Inhalt einer Datei. */
export async function readBlob(
  repositoryId: string,
  ref: string,
  path: string,
): Promise<BlobContent> {
  const cwd = repositoryPath(repositoryId);
  const commit = await resolveRef(repositoryId, ref);
  if (!commit) throw new GitError(`Referenz ${ref} nicht gefunden.`, 1, '');

  const normalized = normalizePath(path);
  if (!normalized) throw new GitError('Kein Dateipfad angegeben.', 1, '');

  const target = `${commit}:${normalized}`;

  // Erst Typ und Größe prüfen, damit eine 500-MB-Datei nicht in den Speicher
  // gelesen wird, nur um danach als "zu groß" abgewiesen zu werden.
  const info = await runGit(['cat-file', '-t', target], { cwd, allowFailure: true });
  if (info.exitCode !== 0) throw new GitError(`Datei ${normalized} nicht gefunden.`, 1, info.stderr);
  if (info.stdout.toString('utf8').trim() !== 'blob') {
    throw new GitError(`${normalized} ist keine Datei.`, 1, '');
  }

  const sizeOutput = await runGitText(['cat-file', '-s', target], { cwd });
  const size = Number(sizeOutput.trim());
  const oid = (await runGitText(['rev-parse', target], { cwd })).trim();

  if (size > config.git.maxBlobDisplayBytes) {
    return {
      path: normalized,
      oid,
      size,
      isBinary: false,
      content: null,
      tooLarge: true,
      encoding: null,
      language: detectLanguage(normalized),
      lineCount: null,
    };
  }

  const raw = (await runGit(['cat-file', 'blob', target], { cwd, maxBuffer: size + 1024 })).stdout;
  const binary = isBinaryBuffer(raw);

  return {
    path: normalized,
    oid,
    size,
    isBinary: binary,
    content: binary ? raw.toString('base64') : raw.toString('utf8'),
    tooLarge: false,
    encoding: binary ? 'base64' : 'utf-8',
    language: binary ? null : detectLanguage(normalized),
    lineCount: binary ? null : raw.toString('utf8').split('\n').length,
  };
}

/** Gibt den Rohinhalt einer Datei als Buffer zurück (für Downloads). */
export async function readBlobRaw(
  repositoryId: string,
  ref: string,
  path: string,
): Promise<{ buffer: Buffer; size: number }> {
  const cwd = repositoryPath(repositoryId);
  const commit = await resolveRef(repositoryId, ref);
  if (!commit) throw new GitError(`Referenz ${ref} nicht gefunden.`, 1, '');

  const normalized = normalizePath(path);
  const target = `${commit}:${normalized}`;

  const sizeOutput = await runGit(['cat-file', '-s', target], { cwd, allowFailure: true });
  if (sizeOutput.exitCode !== 0) throw new GitError('Datei nicht gefunden.', 1, '');
  const size = Number(sizeOutput.stdout.toString('utf8').trim());

  const result = await runGit(['cat-file', 'blob', target], { cwd, maxBuffer: size + 1024 });
  return { buffer: result.stdout, size };
}

/**
 * Normalisiert einen Pfad innerhalb des Repositories.
 *
 * Entfernt führende Schrägstriche und weist jeden Pfad ab, der ein
 * `..`-Segment enthält. Git selbst würde ein solches Segment zwar ablehnen,
 * aber die Prüfung hier ist billiger und macht die Absicht explizit.
 */
export function normalizePath(path: string): string {
  const cleaned = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return '';
  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new GitError('Ungültiger Pfad.', 1, '');
    }
    if (segment.includes('\0')) {
      throw new GitError('Ungültiger Pfad.', 1, '');
    }
  }
  return segments.join('/');
}

/**
 * Heuristik für Binärdateien: ein Nullbyte in den ersten 8000 Bytes.
 * Dieselbe Regel verwendet Git selbst.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitListOptions {
  ref: string;
  path?: string;
  limit?: number;
  skip?: number;
  author?: string;
  search?: string;
  since?: string;
  until?: string;
}

export async function listCommits(
  repositoryId: string,
  options: CommitListOptions,
): Promise<CommitSummary[]> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(options.ref, 'Referenz');

  const args = [
    'log',
    `--pretty=format:${COMMIT_FORMAT}${RECORD}`,
    `--max-count=${Math.min(options.limit ?? 30, 200)}`,
    `--skip=${Math.max(options.skip ?? 0, 0)}`,
  ];

  // Filter werden als eigenständige Argumente übergeben, nie in einen String
  // interpoliert – der Wert kann beliebige Zeichen enthalten.
  if (options.author) args.push(`--author=${options.author}`);
  if (options.search) args.push(`--grep=${options.search}`, '--regexp-ignore-case', '--fixed-strings');
  if (options.since) args.push(`--since=${options.since}`);
  if (options.until) args.push(`--until=${options.until}`);

  args.push(options.ref);

  if (options.path) {
    args.push('--', normalizePath(options.path));
  }

  const output = await runGitText(args, { cwd });

  const commits: CommitSummary[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parsed = parseCommitRecord(trimmed);
    if (parsed) commits.push(parsed);
  }
  return commits;
}

export async function countCommits(repositoryId: string, ref: string, path?: string): Promise<number> {
  assertNotOption(ref, 'Referenz');
  const args = ['rev-list', '--count', ref];
  if (path) args.push('--', normalizePath(path));

  const result = await runGit(args, { cwd: repositoryPath(repositoryId), allowFailure: true });
  if (result.exitCode !== 0) return 0;
  return Number(result.stdout.toString('utf8').trim()) || 0;
}

/** Lädt einen Commit samt Diff gegen seinen ersten Elternteil. */
export async function getCommit(repositoryId: string, oid: string): Promise<CommitDetail> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(oid, 'Commit');

  const output = await runGitText(['log', '-1', `--pretty=format:${COMMIT_FORMAT}`, oid], { cwd });
  const summary = parseCommitRecord(output);
  if (!summary) throw new GitError(`Commit ${oid} nicht gefunden.`, 1, '');

  // Merge-Commits werden gegen den ersten Elternteil verglichen; ein
  // kombinierter Diff wäre für die Anzeige kaum lesbar.
  const base = summary.parents[0];
  const { files, stats } = base
    ? await getDiff(repositoryId, base, summary.oid)
    : await getDiffAgainstEmpty(repositoryId, summary.oid);

  return { ...summary, files, stats };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<string, DiffStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

export async function getDiff(
  repositoryId: string,
  baseRef: string,
  headRef: string,
  options: { path?: string; contextLines?: number } = {},
): Promise<{ files: DiffFile[]; stats: DiffStats }> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(baseRef, 'Basis');
  assertNotOption(headRef, 'Head');

  // Schritt 1: Dateiliste mit Statuscodes und Zählern.
  const nameStatus = await runGitText(
    ['diff', '--name-status', '-z', '--find-renames', `${baseRef}..${headRef}`],
    { cwd },
  );

  const numStat = await runGitText(
    ['diff', '--numstat', '-z', '--find-renames', `${baseRef}..${headRef}`],
    { cwd },
  );

  const fileStatuses = parseNameStatus(nameStatus);
  const counts = parseNumStat(numStat);

  // Schritt 2: Der eigentliche Patch, pro Datei geparst.
  const contextLines = options.contextLines ?? 3;
  const patchArgs = [
    'diff',
    `--unified=${contextLines}`,
    '--find-renames',
    '--no-color',
    `${baseRef}..${headRef}`,
  ];
  if (options.path) patchArgs.push('--', normalizePath(options.path));

  const patch = await runGitText(patchArgs, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const hunksByFile = parseUnifiedDiff(patch);

  const files: DiffFile[] = [];
  let additions = 0;
  let deletions = 0;

  for (const entry of fileStatuses) {
    const count = counts.get(entry.path) ?? { additions: 0, deletions: 0, isBinary: false };
    additions += count.additions;
    deletions += count.deletions;

    const hunks = hunksByFile.get(entry.path) ?? null;
    const patchSize = hunks ? hunks.reduce((sum, h) => sum + h.lines.length, 0) : 0;
    const truncated = patchSize * 100 > config.git.maxDiffBytes;

    files.push({
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      additions: count.additions,
      deletions: count.deletions,
      isBinary: count.isBinary,
      hunks: count.isBinary || truncated ? null : hunks,
      truncated,
    });
  }

  return {
    files,
    stats: { filesChanged: files.length, additions, deletions },
  };
}

/** Diff eines Commits ohne Eltern (erster Commit eines Repositories). */
async function getDiffAgainstEmpty(
  repositoryId: string,
  oid: string,
): Promise<{ files: DiffFile[]; stats: DiffStats }> {
  const cwd = repositoryPath(repositoryId);

  // Der leere Tree hat in Git einen festen, bekannten Hash.
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  return getDiff(repositoryId, EMPTY_TREE, oid);
}

interface NameStatusEntry {
  path: string;
  previousPath: string | null;
  status: DiffStatus;
}

/**
 * Parst `--name-status -z`.
 *
 * Bei Umbenennungen folgen auf den Statuscode ZWEI Pfade (alt, neu), bei allen
 * anderen Status genau einer. Das macht das Parsen zustandsbehaftet.
 */
function parseNameStatus(output: string): NameStatusEntry[] {
  const parts = output.split('\0').filter((p) => p.length > 0);
  const entries: NameStatusEntry[] = [];

  let i = 0;
  while (i < parts.length) {
    const code = parts[i]!;
    const letter = code[0]!;
    const status = STATUS_MAP[letter] ?? 'modified';

    if (letter === 'R' || letter === 'C') {
      const previousPath = parts[i + 1];
      const path = parts[i + 2];
      if (previousPath === undefined || path === undefined) break;
      entries.push({ path, previousPath, status });
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path === undefined) break;
      entries.push({ path, previousPath: null, status });
      i += 2;
    }
  }

  return entries;
}

/**
 * Parst `--numstat -z`.
 * Binärdateien melden `-` statt Zahlen.
 */
function parseNumStat(
  output: string,
): Map<string, { additions: number; deletions: number; isBinary: boolean }> {
  const result = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
  const parts = output.split('\0').filter((p) => p.length > 0);

  let i = 0;
  while (i < parts.length) {
    const record = parts[i]!;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(record);
    if (!match) {
      i += 1;
      continue;
    }

    const [, addRaw, delRaw, pathInRecord] = match;
    const isBinary = addRaw === '-' || delRaw === '-';

    // Bei Umbenennungen ist der Pfad im Record leer und die beiden folgenden
    // Einträge sind alter und neuer Pfad.
    let path = pathInRecord!;
    if (path === '') {
      path = parts[i + 2] ?? '';
      i += 3;
    } else {
      i += 1;
    }

    result.set(path, {
      additions: isBinary ? 0 : Number(addRaw),
      deletions: isBinary ? 0 : Number(delRaw),
      isBinary,
    });
  }

  return result;
}

/**
 * Parst einen Unified-Diff in Hunks pro Datei.
 *
 * Der Dateiname wird aus der `+++ b/<pfad>`-Zeile gelesen. Enthält ein Pfad
 * Sonderzeichen, zitiert Git ihn – diese Zitierung wird rückgängig gemacht.
 */
function parseUnifiedDiff(patch: string): Map<string, DiffHunk[]> {
  const byFile = new Map<string, DiffHunk[]>();
  const lines = patch.split('\n');

  let currentFile: string | null = null;
  let currentHunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flushFile = () => {
    if (currentFile) {
      if (currentHunk) currentHunks.push(currentHunk);
      byFile.set(currentFile, currentHunks);
    }
    currentHunks = [];
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      currentFile = null;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      currentFile = raw === '/dev/null' ? currentFile : unquotePath(raw.replace(/^b\//, ''));
      continue;
    }

    if (line.startsWith('--- ')) continue;

    if (line.startsWith('@@')) {
      if (currentHunk) currentHunks.push(currentHunk);

      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) continue;

      oldLine = Number(match[1]);
      newLine = Number(match[3]);

      currentHunk = {
        header: match[5]?.trim() ?? '',
        oldStart: oldLine,
        oldLines: Number(match[2] ?? 1),
        newStart: newLine,
        newLines: Number(match[4] ?? 1),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    const marker = line[0];
    if (marker === '+') {
      currentHunk.lines.push({
        type: 'addition',
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      newLine += 1;
    } else if (marker === '-') {
      currentHunk.lines.push({
        type: 'deletion',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      oldLine += 1;
    } else if (marker === ' ') {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
    // "\ No newline at end of file" und leere Zeilen werden übersprungen.
  }

  flushFile();
  return byFile;
}

/** Macht die C-artige Zitierung von Git-Pfaden rückgängig. */
function unquotePath(path: string): string {
  if (!path.startsWith('"')) return path;
  const inner = path.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return char;
    }
  });
}

// ---------------------------------------------------------------------------
// Merge-Analyse
// ---------------------------------------------------------------------------

/**
 * Prüft, ob zwei Refs konfliktfrei zusammengeführt werden können.
 *
 * Nutzt `merge-tree`, das rein in der Objektdatenbank arbeitet – es wird kein
 * Arbeitsverzeichnis angelegt und nichts in das Repository geschrieben.
 */
export async function checkMergeable(
  repositoryId: string,
  baseRef: string,
  headRef: string,
): Promise<{ mergeable: boolean; conflictingFiles: string[]; mergeBase: string | null }> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(baseRef, 'Basis');
  assertNotOption(headRef, 'Head');

  const baseResult = await runGit(['merge-base', baseRef, headRef], { cwd, allowFailure: true });
  const mergeBase = baseResult.exitCode === 0 ? baseResult.stdout.toString('utf8').trim() : null;

  // --write-tree gibt bei Erfolg den Tree-Hash aus, bei Konflikt eine Liste
  // der betroffenen Dateien und Exit-Code 1.
  const result = await runGit(['merge-tree', '--write-tree', '--name-only', baseRef, headRef], {
    cwd,
    allowFailure: true,
  });

  if (result.exitCode === 0) {
    return { mergeable: true, conflictingFiles: [], mergeBase };
  }

  const output = result.stdout.toString('utf8').split('\n');
  // Die erste Zeile ist der (unvollständige) Tree, danach folgen die Konflikte.
  const conflictingFiles = output.slice(1).map((l) => l.trim()).filter(Boolean);

  return { mergeable: false, conflictingFiles, mergeBase };
}

/** Commits, die in `headRef` enthalten sind, aber nicht in `baseRef`. */
export async function commitsBetween(
  repositoryId: string,
  baseRef: string,
  headRef: string,
  limit = 250,
): Promise<CommitSummary[]> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(baseRef, 'Basis');
  assertNotOption(headRef, 'Head');

  const output = await runGitText(
    [
      'log',
      `--pretty=format:${COMMIT_FORMAT}${RECORD}`,
      `--max-count=${limit}`,
      `${baseRef}..${headRef}`,
    ],
    { cwd },
  );

  const commits: CommitSummary[] = [];
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parsed = parseCommitRecord(trimmed);
    if (parsed) commits.push(parsed);
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Blame
// ---------------------------------------------------------------------------

export interface BlameLine {
  oid: string;
  lineNumber: number;
  content: string;
  authorName: string;
  authorEmail: string;
  authorTime: string;
  summary: string;
}

/**
 * Blame für eine Datei.
 * `--line-porcelain` wiederholt die Commit-Metadaten für jede Zeile, was das
 * Parsen einfach macht – der Mehraufwand ist bei einer einzelnen Datei egal.
 */
export async function blameFile(
  repositoryId: string,
  ref: string,
  path: string,
): Promise<BlameLine[]> {
  const cwd = repositoryPath(repositoryId);
  assertNotOption(ref, 'Referenz');
  const normalized = normalizePath(path);

  const output = await runGitText(['blame', '--line-porcelain', ref, '--', normalized], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });

  const result: BlameLine[] = [];
  const lines = output.split('\n');

  let current: Partial<BlameLine> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    const headerMatch = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (headerMatch) {
      current = { oid: headerMatch[1]!, lineNumber: Number(headerMatch[3]) };
      continue;
    }

    if (line.startsWith('author ')) current.authorName = line.slice(7);
    else if (line.startsWith('author-mail ')) current.authorEmail = line.slice(12).replace(/[<>]/g, '');
    else if (line.startsWith('author-time ')) {
      current.authorTime = new Date(Number(line.slice(12)) * 1000).toISOString();
    } else if (line.startsWith('summary ')) current.summary = line.slice(8);
    else if (line.startsWith('\t')) {
      // Die Inhaltszeile beginnt mit einem Tab.
      result.push({
        oid: current.oid ?? '',
        lineNumber: current.lineNumber ?? result.length + 1,
        content: line.slice(1),
        authorName: current.authorName ?? '',
        authorEmail: current.authorEmail ?? '',
        authorTime: current.authorTime ?? '',
        summary: current.summary ?? '',
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schreibende Operationen ohne Arbeitsverzeichnis
// ---------------------------------------------------------------------------

/** Eine einzelne Änderung innerhalb eines Commits. */
export interface FileChange {
  /** Pfad im Repository. */
  path: string;
  /** Null löscht die Datei. */
  content: Buffer | null;
  /** Zielpfad bei Umbenennung. */
  newPath?: string;
  /** Ausführbares Bit; voreingestellt ist 100644. */
  executable?: boolean;
}

/**
 * Erstellt einen Commit, der mehrere Dateien setzt, umbenennt oder löscht.
 *
 * Arbeitet ausschließlich über die Plumbing-Kommandos hash-object, read-tree,
 * update-index, write-tree und commit-tree. Es wird kein Arbeitsverzeichnis
 * angelegt – das wäre bei gleichzeitigen Bearbeitungen desselben Repositories
 * eine Fehlerquelle und würde Festplattenplatz kosten.
 *
 * Alle Änderungen landen in **einem** Commit. Das ist nicht nur hübscher,
 * sondern der Grund, warum es diese Funktion gibt: Beim Hochladen von zwanzig
 * Dateien wären zwanzig Commits sowohl in der Historie als auch für Hooks und
 * Spiegelungen Unsinn.
 */
export async function commitFileChanges(
  repositoryId: string,
  options: {
    /** Branch, auf den der Commit zeigt. */
    branch: string;
    /**
     * Ausgangsbranch, falls `branch` noch nicht existiert. Damit entsteht ein
     * neuer Branch aus dem aktuellen Stand – der Weg, um an einem geschützten
     * Branch vorbei einen Pull Request vorzubereiten.
     */
    startBranch?: string;
    changes: FileChange[];
    message: string;
    author: { name: string; email: string };
    /** Erwarteter aktueller Branch-Stand; verhindert verlorene Änderungen. */
    expectedOid?: string | null;
  },
): Promise<string> {
  const cwd = repositoryPath(repositoryId);
  const branch = assertNotOption(options.branch, 'Branch-Name');

  if (options.changes.length === 0) {
    throw new GitError('Es wurde keine Änderung übergeben.', 1, '');
  }

  // Der Stand, auf dem der Commit aufsetzt. Bei einem neuen Branch ist das
  // der Ausgangsbranch; der neue Branch selbst hat noch keinen.
  const branchOid = await resolveRef(repositoryId, branch);
  const parentOid =
    branchOid ??
    (options.startBranch
      ? await resolveRef(repositoryId, assertNotOption(options.startBranch, 'Ausgangsbranch'))
      : null);

  if (options.expectedOid !== undefined && options.expectedOid !== null) {
    if (branchOid !== options.expectedOid) {
      throw new GitError(
        'Der Branch wurde zwischenzeitlich geändert. Lade die Seite neu und wiederhole die Änderung.',
        1,
        '',
      );
    }
  }

  // Doppelte Zielpfade würden sich gegenseitig überschreiben, und zwar
  // abhängig von der Reihenfolge. Lieber eine klare Meldung.
  const targets = new Set<string>();
  for (const change of options.changes) {
    const target = normalizePath(change.newPath ?? change.path);
    if (!target) throw new GitError('Ein Pfad darf nicht leer sein.', 1, '');
    if (targets.has(target)) {
      throw new GitError(`Der Pfad "${target}" kommt mehrfach vor.`, 1, '');
    }
    targets.add(target);
  }

  // Ein temporärer Index pro Operation, damit parallele Änderungen am selben
  // Repository sich nicht gegenseitig überschreiben.
  const indexFile = `${cwd}/index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    if (parentOid) {
      await runGit(['read-tree', parentOid], { cwd, env });
    } else {
      await runGit(['read-tree', '--empty'], { cwd, env });
    }

    for (const change of options.changes) {
      const path = normalizePath(change.path);

      if (change.content === null) {
        await removeFromIndex(cwd, env, path);
        continue;
      }

      const hashResult = await runGit(['hash-object', '-w', '--stdin'], {
        cwd,
        input: change.content,
      });
      const blobOid = hashResult.stdout.toString('utf8').trim();

      const targetPath = change.newPath ? normalizePath(change.newPath) : path;
      if (change.newPath && targetPath !== path) {
        await removeFromIndex(cwd, env, path);
      }

      const mode = change.executable ? '100755' : '100644';
      await runGit(['update-index', '--add', '--cacheinfo', `${mode},${blobOid},${targetPath}`], {
        cwd,
        env,
      });
    }

    const treeOid = (await runGitText(['write-tree'], { cwd, env })).trim();

    const commitArgs = ['commit-tree', treeOid, '-m', options.message];
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

    // update-ref mit altem Wert: schlägt fehl, wenn jemand anderes den Branch
    // zwischenzeitlich verschoben hat. Das ist die eigentliche Absicherung
    // gegen verlorene Änderungen, nicht die Prüfung weiter oben. Der leere
    // alte Wert verlangt, dass der Branch noch nicht existiert – damit kann
    // ein neuer Branch keinen bestehenden überschreiben.
    const updateArgs = ['update-ref', `refs/heads/${branch}`, commitOid];
    updateArgs.push(branchOid ?? '');

    await runGit(updateArgs, { cwd });

    return commitOid;
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(indexFile).catch(() => {});
  }
}

/**
 * Commit mit genau einer Änderung. Dünne Hülle um `commitFileChanges`, damit
 * es nur eine Implementierung des eigentlichen Ablaufs gibt.
 */
export async function commitFileChange(
  repositoryId: string,
  options: {
    branch: string;
    startBranch?: string;
    path: string;
    content: Buffer | null;
    message: string;
    author: { name: string; email: string };
    expectedOid?: string | null;
    newPath?: string;
  },
): Promise<string> {
  const change: FileChange = { path: options.path, content: options.content };
  if (options.newPath !== undefined) change.newPath = options.newPath;

  return commitFileChanges(repositoryId, {
    branch: options.branch,
    ...(options.startBranch !== undefined ? { startBranch: options.startBranch } : {}),
    changes: [change],
    message: options.message,
    author: options.author,
    ...(options.expectedOid !== undefined ? { expectedOid: options.expectedOid } : {}),
  });
}

/**
 * Entfernt einen Pfad aus dem Index.
 *
 * `update-index --force-remove` scheidet aus: es verlangt ein
 * Arbeitsverzeichnis, das ein bare-Repository nicht hat. `--index-info` liest
 * die Einträge stattdessen von stdin und funktioniert ohne Arbeitsbaum. Ein
 * Modus von 0 mit Null-Objekt bedeutet "Eintrag löschen".
 *
 * Die `-z`-Variante trennt Datensätze mit Nullbytes, damit Dateinamen mit
 * Zeilenumbrüchen korrekt behandelt werden.
 */
async function removeFromIndex(
  cwd: string,
  env: Record<string, string>,
  path: string,
): Promise<void> {
  const record = `0 0000000000000000000000000000000000000000\t${path}\0`;
  await runGit(['update-index', '-z', '--index-info'], { cwd, env, input: record });
}

/**
 * Führt zwei Branches zusammen.
 *
 * `merge-tree --write-tree` erzeugt den Ergebnis-Tree ohne Arbeitsverzeichnis;
 * daraus wird mit commit-tree der Merge-Commit gebaut und der Ziel-Branch
 * vorgerückt.
 */
export async function mergeBranches(
  repositoryId: string,
  options: {
    baseBranch: string;
    headRef: string;
    message: string;
    author: { name: string; email: string };
    strategy: 'merge' | 'squash';
  },
): Promise<string> {
  const cwd = repositoryPath(repositoryId);
  const baseBranch = assertNotOption(options.baseBranch, 'Basis-Branch');
  const headRef = assertNotOption(options.headRef, 'Head');

  const baseOid = await resolveRef(repositoryId, baseBranch);
  const headOid = await resolveRef(repositoryId, headRef);
  if (!baseOid || !headOid) throw new GitError('Basis oder Head nicht gefunden.', 1, '');

  const treeResult = await runGit(['merge-tree', '--write-tree', baseOid, headOid], {
    cwd,
    allowFailure: true,
  });

  if (treeResult.exitCode !== 0) {
    throw new GitError('Der Merge hat Konflikte und kann nicht automatisch ausgeführt werden.', 1, '');
  }

  const treeOid = treeResult.stdout.toString('utf8').split('\n')[0]!.trim();

  const commitArgs = ['commit-tree', treeOid, '-m', options.message, '-p', baseOid];
  // Beim Squash entfällt der zweite Elternteil: die Historie des Branches
  // wird bewusst nicht übernommen.
  if (options.strategy === 'merge') commitArgs.push('-p', headOid);

  const commitOid = (
    await runGitText(commitArgs, {
      cwd,
      env: {
        GIT_AUTHOR_NAME: options.author.name,
        GIT_AUTHOR_EMAIL: options.author.email,
        GIT_COMMITTER_NAME: options.author.name,
        GIT_COMMITTER_EMAIL: options.author.email,
      },
    })
  ).trim();

  await runGit(['update-ref', `refs/heads/${baseBranch}`, commitOid, baseOid], { cwd });

  return commitOid;
}

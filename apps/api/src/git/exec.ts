/**
 * Ausführung von Git-Unterprozessen.
 *
 * Sicherheitsregeln, die hier erzwungen werden:
 *
 *  1. Immer `spawn` mit Argument-Array – niemals eine Shell. Damit sind
 *     Shell-Metazeichen in Branch- oder Dateinamen wirkungslos.
 *  2. Argumente, die von Benutzereingaben stammen, werden mit `--` vom Rest
 *     getrennt, damit ein Name wie `--upload-pack=rm` nicht als Option gilt.
 *  3. Die Umgebung wird auf eine Positivliste reduziert. Variablen wie
 *     GIT_SSH_COMMAND oder GIT_EXTERNAL_DIFF könnten sonst Code ausführen.
 *  4. Jeder Prozess hat ein Zeitlimit und eine Ausgabegrenze.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { config } from '../config.js';

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Daten, die auf stdin geschrieben werden. */
  input?: Buffer | string;
  /** Maximale Bytes, die von stdout eingelesen werden. */
  maxBuffer?: number;
  /** Zusätzliche Umgebungsvariablen (werden gegen die Positivliste geprüft). */
  env?: Record<string, string>;
  /** Wenn true, wird ein Exit-Code ungleich 0 nicht als Fehler behandelt. */
  allowFailure?: boolean;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Erlaubte Umgebungsvariablen für Git-Unterprozesse.
 *
 * Alles andere wird entfernt. Insbesondere GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF,
 * GIT_PAGER und GIT_CONFIG_* sind gefährlich, weil Git darüber beliebige
 * Programme startet.
 */
const ALLOWED_EXTRA_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_PROTOCOL',
  'GIT_NAMESPACE',
  // Eigene Variablen, die der pre-receive-Hook liest.
  'FORGE_PUSH_CONTEXT',
]);

function buildEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    // Verhindert, dass Git interaktiv nach Zugangsdaten fragt und hängen bleibt.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    // Ignoriert ~/.gitconfig und /etc/gitconfig – die Konfiguration soll
    // ausschließlich aus dem Repository selbst kommen.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!ALLOWED_EXTRA_ENV.has(key)) {
        throw new Error(`Umgebungsvariable ${key} ist für Git-Prozesse nicht zugelassen.`);
      }
      env[key] = value;
    }
  }

  return env;
}

/**
 * Führt ein Git-Kommando aus und sammelt die Ausgabe.
 *
 * Für große Ausgaben (Packfiles) nicht geeignet – dafür `streamGit` verwenden.
 */
export function runGit(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? config.git.processTimeoutMs;
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  return new Promise((resolvePromise, rejectPromise) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: buildEnvironment(options.env),
      // Niemals eine Shell: sonst wären Metazeichen in Argumenten gefährlich.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    const child = spawn('git', args, spawnOptions);

    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxBuffer) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(new GitError('Ausgabe des Git-Prozesses zu groß.', -1, stderr));
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr wird begrenzt, damit eine Fehlerschleife nicht den Speicher füllt.
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new GitError(`Git konnte nicht gestartet werden: ${error.message}`, -1, stderr));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        rejectPromise(
          new GitError(`Git-Prozess nach ${timeoutMs} ms abgebrochen.`, -1, stderr),
        );
        return;
      }

      const exitCode = code ?? -1;
      const result: GitResult = {
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderr.trim(),
        exitCode,
      };

      if (exitCode !== 0 && !options.allowFailure) {
        rejectPromise(
          new GitError(
            `git ${args[0] ?? ''} ist mit Code ${exitCode} fehlgeschlagen: ${result.stderr}`,
            exitCode,
            result.stderr,
          ),
        );
        return;
      }

      resolvePromise(result);
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Wie `runGit`, gibt die Ausgabe aber als UTF-8-String zurück. */
export async function runGitText(args: string[], options: GitRunOptions = {}): Promise<string> {
  const result = await runGit(args, options);
  return result.stdout.toString('utf8');
}

/**
 * Startet ein Git-Kommando und gibt den Prozess zurück, damit der Aufrufer
 * die Streams selbst verdrahten kann. Für `upload-pack` und `receive-pack`.
 */
export function spawnGit(args: string[], options: GitRunOptions = {}) {
  return spawn('git', args, {
    cwd: options.cwd,
    env: buildEnvironment(options.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Stellt sicher, dass ein benutzergesteuerter Wert nicht als Option
 * interpretiert wird. Git behandelt führende Bindestriche als Optionen – ein
 * Branch namens `--help` würde sonst das falsche Verhalten auslösen.
 */
export function assertNotOption(value: string, label: string): string {
  if (value.startsWith('-')) {
    throw new Error(`${label} darf nicht mit einem Bindestrich beginnen.`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} enthält ein Nullbyte.`);
  }
  return value;
}

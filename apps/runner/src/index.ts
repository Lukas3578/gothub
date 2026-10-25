/**
 * Forge Runner.
 *
 * Ein eigenständiger Prozess, der bei der API nach Arbeit fragt und Jobs in
 * Docker-Containern ausführt. Er läuft bewusst getrennt vom API-Prozess:
 * fremder Code aus Workflow-Dateien darf nie im selben Prozess wie die
 * Plattform laufen, und der Runner soll auf einer anderen Maschine stehen
 * können.
 *
 * Isolation jedes Jobs:
 *  - eigener Container, der nach dem Job gelöscht wird
 *  - CPU- und Speicherlimit
 *  - Laufzeitlimit, nach dem der Container hart beendet wird
 *  - kein Zugriff auf den Docker-Socket (keine Container-im-Container)
 *  - alle Linux-Capabilities abgelegt, no-new-privileges gesetzt
 *  - schreibbar nur das Arbeitsverzeichnis und /tmp
 *  - Netzwerk abschaltbar
 *
 * Secrets gelangen über eine Datei in den Container, die als Umgebung geladen
 * wird – nicht über die Kommandozeile, weil Kommandozeilen anderer Prozesse
 * auf demselben Host lesbar sind.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const API_URL = (process.env.FORGE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const TOKEN = process.env.FORGE_RUNNER_TOKEN ?? '';
const LABELS = (process.env.FORGE_RUNNER_LABELS ?? 'self-hosted,ubuntu-latest')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);

const CPU_LIMIT = process.env.FORGE_RUNNER_CPUS ?? '1';
const MEMORY_LIMIT = process.env.FORGE_RUNNER_MEMORY ?? '1g';
const PIDS_LIMIT = process.env.FORGE_RUNNER_PIDS ?? '256';
const NETWORK_MODE = process.env.FORGE_RUNNER_NETWORK ?? 'bridge';
const POLL_INTERVAL_MS = Number(process.env.FORGE_RUNNER_POLL_MS ?? 3000);

if (!TOKEN) {
  console.error('FORGE_RUNNER_TOKEN ist nicht gesetzt. Der Runner kann sich nicht anmelden.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API-Zugriff
// ---------------------------------------------------------------------------

async function api<T>(path: string, body?: unknown, raw?: Buffer, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: raw ?? (body === undefined ? '{}' : JSON.stringify(body)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API ${path} antwortete mit ${response.status}: ${text.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Jobdaten
// ---------------------------------------------------------------------------

interface JobStep {
  stepNumber: number;
  name: string;
  run: string | null;
  uses: string | null;
  with: Record<string, string>;
  env: Record<string, string>;
  workingDirectory: string | null;
  continueOnError: boolean;
  shell: string;
  if: string | null;
}

interface Job {
  jobId: string;
  runId: string;
  jobKey: string;
  name: string;
  repositoryFullName: string;
  cloneUrl: string;
  headSha: string;
  headBranch: string | null;
  image: string;
  steps: JobStep[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  timeoutMinutes: number;
}

// ---------------------------------------------------------------------------
// Hilfsprozesse
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Führt ein Kommando aus und reicht die Ausgabe zeilenweise an `onOutput`.
 * Wird für docker-Aufrufe und für das Klonen verwendet.
 */
function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; onOutput?: (chunk: string) => void; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false });
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    const forward = (chunk: Buffer) => options.onOutput?.(chunk.toString('utf8'));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    child.on('error', (error) => {
      options.onOutput?.(`Prozessfehler: ${error.message}\n`);
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: -1, timedOut });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: code ?? -1, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Logpuffer
// ---------------------------------------------------------------------------

/**
 * Sammelt Logausgaben und schickt sie gebündelt zum Server.
 *
 * Eine Anfrage pro Zeile wäre bei einem gesprächigen Build verschwenderisch;
 * ein einziger Block am Ende würde die Live-Ansicht unbrauchbar machen.
 * Deshalb: alle 1,5 Sekunden oder bei 32 KB.
 */
class LogBuffer {
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private stepNumber: number | null = null;
  private flushing = false;
  /** Geheimniswerte, die vor dem Senden ersetzt werden. */
  private masks: string[] = [];

  constructor(private readonly jobId: string) {}

  /**
   * Hinterlegt Werte, die im Log nie erscheinen dürfen.
   *
   * Nötig, weil ein Schritt ein Secret versehentlich ausgeben kann – etwa
   * durch `set -x`, ein `echo` zur Fehlersuche oder eine Fehlermeldung eines
   * Programms, das den Wert mitführt. Sehr kurze Werte werden ausgelassen:
   * ein Secret mit zwei Zeichen würde sonst halbe Logzeilen schwärzen.
   */
  maskValues(values: string[]): void {
    this.masks = values
      .filter((value) => value.length >= 4)
      // Längste zuerst: sonst zerstört ein kurzer Treffer einen längeren.
      .sort((a, b) => b.length - a.length);
  }

  private applyMasks(text: string): string {
    let result = text;
    for (const value of this.masks) {
      result = result.split(value).join('***');
    }
    return result;
  }

  setStep(stepNumber: number | null): void {
    if (this.stepNumber !== stepNumber) {
      void this.flush();
      this.stepNumber = stepNumber;
    }
  }

  write(text: string): void {
    this.buffer += this.applyMasks(text);

    if (this.buffer.length >= 32 * 1024) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1500);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer || this.flushing) return;

    this.flushing = true;
    const content = this.buffer;
    this.buffer = '';

    try {
      await api(`/api/v1/runner/jobs/${this.jobId}/logs`, {
        stepNumber: this.stepNumber,
        content,
      });
    } catch {
      // Logausgaben dürfen den Job nicht scheitern lassen.
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Jobausführung
// ---------------------------------------------------------------------------

async function executeJob(job: Job): Promise<void> {
  const log = new LogBuffer(job.jobId);
  log.maskValues(Object.values(job.secrets));
  const workspace = await mkdtemp(join(tmpdir(), 'forge-job-'));
  const containerName = `forge-${job.jobId.slice(0, 12)}`;
  const deadline = Date.now() + job.timeoutMinutes * 60_000;

  let heartbeat: NodeJS.Timeout | null = null;
  let cancelled = false;

  heartbeat = setInterval(async () => {
    try {
      const result = await api<{ continue: boolean }>(
        `/api/v1/runner/jobs/${job.jobId}/heartbeat`,
      );
      if (!result.continue) {
        cancelled = true;
        // Der Lauf wurde abgebrochen: Container sofort beenden.
        void runProcess('docker', ['kill', containerName]);
      }
    } catch {
      // Ein verpasstes Lebenszeichen ist nicht sofort kritisch; der Server
      // gibt den Job erst nach Ablauf der Lease frei.
    }
  }, 30_000);

  const finish = async (
    status: 'success' | 'failure' | 'cancelled' | 'timed_out',
    exitCode: number | null,
    errorMessage: string | null,
  ) => {
    if (heartbeat) clearInterval(heartbeat);
    await log.flush();

    await runProcess('docker', ['rm', '-f', containerName]).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});

    await api(`/api/v1/runner/jobs/${job.jobId}/complete`, { status, exitCode, errorMessage }).catch(
      (error) => console.error('Abschlussmeldung fehlgeschlagen:', error),
    );
  };

  try {
    log.write(`Job "${job.name}" auf Runner gestartet.\n`);
    log.write(`Repository: ${job.repositoryFullName} @ ${job.headSha.slice(0, 8)}\n`);
    log.write(`Image: ${job.image}\n\n`);

    // ---- Quelltext holen ---------------------------------------------------
    log.setStep(null);
    log.write('→ Quelltext wird geklont…\n');

    const cloneUrl = job.cloneUrl.replace('://', `://runner:${TOKEN}@`);
    const sourceDir = join(workspace, 'source');
    await mkdir(sourceDir, { recursive: true });

    const clone = await runProcess(
      'git',
      ['clone', '--no-checkout', '--quiet', cloneUrl, sourceDir],
      {
        timeoutMs: 300_000,
        // Die URL enthält das Token; es darf nicht im Log landen.
        onOutput: (chunk) => log.write(chunk.replaceAll(TOKEN, '***')),
      },
    );

    if (clone.exitCode !== 0) {
      log.write('Das Repository konnte nicht geklont werden.\n');
      await finish('failure', clone.exitCode, 'Klonen fehlgeschlagen.');
      return;
    }

    const checkout = await runProcess('git', ['checkout', '--quiet', job.headSha], {
      cwd: sourceDir,
      timeoutMs: 120_000,
      onOutput: (chunk) => log.write(chunk),
    });

    if (checkout.exitCode !== 0) {
      await finish('failure', checkout.exitCode, 'Checkout fehlgeschlagen.');
      return;
    }

    // Die Zugangsdaten aus der Remote entfernen: der Workflow-Code läuft
    // gleich im selben Verzeichnis und könnte sie sonst auslesen.
    await runProcess('git', ['remote', 'remove', 'origin'], { cwd: sourceDir });

    log.write('✓ Quelltext bereit.\n\n');

    // ---- Umgebung vorbereiten ---------------------------------------------
    //
    // Docker liest die env-Datei zeilenweise als KEY=VALUE. Ein Wert mit
    // Zeilenumbruch würde deshalb beliebige weitere Variablen einschleusen –
    // etwa PATH oder LD_PRELOAD. Solche Werte werden verworfen statt
    // stillschweigend abgeschnitten, damit der Fehler im Log auffällt.
    const envFile = join(workspace, 'job.env');
    const envLines: string[] = [];

    const addEnv = (key: string, value: string, label: string): void => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        log.write(`! Umgebungsvariable "${key}" hat einen unzulässigen Namen und wird übergangen.\n`);
        return;
      }
      if (/[\r\n\0]/.test(value)) {
        log.write(`! ${label} "${key}" enthält Zeilenumbrüche und wird übergangen.\n`);
        return;
      }
      envLines.push(`${key}=${value}`);
    };

    for (const [key, value] of Object.entries(job.env)) {
      addEnv(key, value, 'Umgebungsvariable');
    }

    // Secrets stehen AUSSCHLIESSLICH unter dem Präfix FORGE_SECRET_ zur
    // Verfügung, zu dem der Server `${{ secrets.X }}` auflöst. Würden sie
    // zusätzlich unter ihrem Klarnamen exportiert, läge jedes Secret in der
    // Umgebung jedes Schritts – auch solcher, die es nie angefordert haben,
    // und ein schlichtes `env` im Log würde alle offenlegen.
    for (const [key, value] of Object.entries(job.secrets)) {
      addEnv(`FORGE_SECRET_${key}`, value, 'Secret');
    }

    await writeFile(envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });

    const artifactDir = join(workspace, 'artifacts');
    await mkdir(artifactDir, { recursive: true });

    // ---- Container starten -------------------------------------------------
    const dockerArgs = [
      'run',
      '--name', containerName,
      '--rm=false',
      '--detach',
      // Ressourcengrenzen: ein Workflow darf den Host nicht lahmlegen.
      `--cpus=${CPU_LIMIT}`,
      `--memory=${MEMORY_LIMIT}`,
      `--pids-limit=${PIDS_LIMIT}`,
      // Keine Rechteausweitung innerhalb des Containers.
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      `--network=${NETWORK_MODE}`,
      // Nur das Arbeitsverzeichnis und /tmp sind beschreibbar.
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,size=512m',
      '--volume', `${sourceDir}:/workspace:rw`,
      '--volume', `${artifactDir}:/artifacts:rw`,
      '--env-file', envFile,
      '--workdir', '/workspace',
      job.image,
      // Der Container bleibt am Leben, die Schritte werden einzeln hinein
      // ausgeführt. So lässt sich jeder Schritt separat melden und der
      // Zustand (Dateien, Verzeichnis) bleibt zwischen Schritten erhalten.
      '/usr/bin/sh',
      '-c',
      'while [ ! -f /tmp/forge-done ]; do sleep 1; done',
    ];

    log.write('→ Container wird gestartet…\n');
    let startOutput = '';
    const start = await runProcess('docker', dockerArgs, {
      timeoutMs: 120_000,
      onOutput: (chunk) => {
        startOutput += chunk;
      },
    });

    if (start.exitCode !== 0) {
      log.write(`Der Container konnte nicht gestartet werden:\n${startOutput}\n`);
      await finish('failure', start.exitCode, 'Container konnte nicht gestartet werden.');
      return;
    }

    log.write('✓ Container läuft.\n\n');

    // ---- Schritte ausführen -------------------------------------------------
    let jobSuccess = true;

    for (const step of job.steps) {
      if (cancelled) break;

      if (Date.now() > deadline) {
        log.setStep(step.stepNumber);
        log.write('\nDas Zeitlimit des Jobs wurde überschritten.\n');
        await api(`/api/v1/runner/jobs/${job.jobId}/steps`, {
          stepNumber: step.stepNumber,
          status: 'timed_out',
        }).catch(() => {});
        await finish('timed_out', null, 'Zeitlimit überschritten.');
        return;
      }

      // Ein Schritt wird übersprungen, wenn ein vorheriger fehlschlug –
      // außer er ist ausdrücklich für diesen Fall vorgesehen.
      const shouldRun = jobSuccess || /failure\(\)|always\(\)/.test(step.if ?? '');

      if (!shouldRun) {
        await api(`/api/v1/runner/jobs/${job.jobId}/steps`, {
          stepNumber: step.stepNumber,
          status: 'skipped',
        }).catch(() => {});
        continue;
      }

      log.setStep(step.stepNumber);
      log.write(`\n━━━ ${step.name} ━━━\n`);

      await api(`/api/v1/runner/jobs/${job.jobId}/steps`, {
        stepNumber: step.stepNumber,
        status: 'running',
      }).catch(() => {});

      const result = await executeStep(job, step, containerName, log, deadline);

      const stepStatus = result.timedOut
        ? 'timed_out'
        : result.exitCode === 0
          ? 'success'
          : 'failure';

      await api(`/api/v1/runner/jobs/${job.jobId}/steps`, {
        stepNumber: step.stepNumber,
        status: stepStatus,
        exitCode: result.exitCode,
      }).catch(() => {});

      if (result.timedOut) {
        log.write('\nDer Schritt hat das Zeitlimit überschritten.\n');
        await finish('timed_out', result.exitCode, 'Zeitlimit überschritten.');
        return;
      }

      if (result.exitCode !== 0) {
        log.write(`\nSchritt fehlgeschlagen mit Code ${result.exitCode}.\n`);
        if (!step.continueOnError) {
          jobSuccess = false;
        } else {
          log.write('(continue-on-error ist gesetzt, der Job läuft weiter.)\n');
        }
      }
    }

    // ---- Artefakte hochladen ------------------------------------------------
    log.setStep(null);
    await uploadArtifacts(job, artifactDir, log);

    if (cancelled) {
      await finish('cancelled', null, 'Der Lauf wurde abgebrochen.');
      return;
    }

    log.write(jobSuccess ? '\n✓ Job erfolgreich abgeschlossen.\n' : '\n✗ Job fehlgeschlagen.\n');
    await finish(jobSuccess ? 'success' : 'failure', jobSuccess ? 0 : 1, null);
  } catch (error) {
    log.write(`\nUnerwarteter Fehler im Runner: ${String(error)}\n`);
    await finish('failure', -1, String(error).slice(0, 2000));
  }
}

/** Führt einen einzelnen Schritt im laufenden Container aus. */
async function executeStep(
  job: Job,
  step: JobStep,
  containerName: string,
  log: LogBuffer,
  deadline: number,
): Promise<RunResult> {
  // Eingebaute Aktionen: statt eines Ökosystems fremder Aktionen gibt es
  // wenige, die hier umgesetzt sind. Alles andere wird klar abgelehnt, statt
  // vorzugeben, es zu unterstützen.
  if (step.uses) {
    return executeAction(job, step, containerName, log, deadline);
  }

  if (!step.run) return { exitCode: 0, timedOut: false };

  const workdir = step.workingDirectory ? `/workspace/${step.workingDirectory}` : '/workspace';
  const shell = step.shell === 'bash' ? '/usr/bin/bash' : '/usr/bin/sh';

  // Schritt-Umgebung als Export-Zeilen im Skript statt über `docker exec --env`.
  //
  // Der Grund: der Server löst `${{ secrets.X }}` zu `${FORGE_SECRET_X}` auf,
  // und diesen Platzhalter kann nur die Shell im Container ersetzen. Docker
  // reicht den Wert einer --env-Angabe unverändert durch, sodass dort buchstäblich
  // "${FORGE_SECRET_X}" in der Variablen landen würde.
  const exports = Object.entries(step.env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${quoteWithSecretRefs(value)}`)
    .join('\n');

  // `set -e` sorgt dafür, dass ein fehlgeschlagenes Kommando den Schritt
  // beendet; ohne das würde nur der Exit-Code des letzten Kommandos zählen.
  const script = [`set -e`, exports, step.run].filter(Boolean).join('\n');

  const remaining = Math.max(deadline - Date.now(), 1000);

  return runProcess(
    'docker',
    ['exec', '--workdir', workdir, containerName, shell, '-c', script],
    {
      timeoutMs: remaining,
      onOutput: (chunk) => log.write(chunk),
    },
  );
}


/**
 * Macht einen Umgebungswert für die Shell sicher.
 *
 * Literale Teile werden in einfache Anführungszeichen gesetzt, sodass die
 * Shell darin nichts interpretiert. Nur die vom Server eingesetzten
 * `${FORGE_SECRET_...}`-Platzhalter bleiben in doppelten Anführungszeichen
 * stehen, damit genau sie – und sonst nichts – ersetzt werden.
 *
 * Aus `pre${FORGE_SECRET_X}post` wird `'pre'"${FORGE_SECRET_X}"'post'`;
 * aneinandergrenzende Zeichenketten fügt die Shell zusammen.
 */
function quoteWithSecretRefs(value: string): string {
  const pattern = /\$\{(FORGE_SECRET_[A-Za-z0-9_]+)\}/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const quoteLiteral = (text: string): string =>
    // Ein einfaches Anführungszeichen beendet die Zeichenkette; es wird durch
    // die übliche Folge '\'' ersetzt.
    `'${text.split("'").join(`'\\''`)}'`;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) parts.push(quoteLiteral(value.slice(lastIndex, match.index)));
    parts.push(`"\${${match[1]}}"`);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) parts.push(quoteLiteral(value.slice(lastIndex)));
  if (parts.length === 0) return "''";
  return parts.join('');
}

/**
 * Eingebaute Aktionen.
 *
 * Es gibt keinen Marktplatz und keine Ausführung fremden Codes: eine Aktion
 * ist hier kein heruntergeladenes Repository, sondern eine feste Umsetzung im
 * Runner. Das ist eine bewusste Einschränkung – fremder Code mit Zugriff auf
 * Secrets und den Docker-Socket wäre ein erhebliches Risiko.
 *
 * Unterstützt werden die drei Aktionen, die in nahezu jedem Workflow stehen,
 * jeweils unter ihrem GitHub-Namen und unter `forge/`. Eine aus GitHub
 * übernommene Datei läuft damit unverändert.
 *
 * Die Version hinter `@` wird gelesen und ignoriert: `actions/checkout@v3`
 * und `@v4` tun hier dasselbe.
 */
const ACTION_ALIASES: Record<string, string> = {
  'actions/checkout': 'checkout',
  'forge/checkout': 'checkout',
  'actions/upload-artifact': 'upload-artifact',
  'forge/upload-artifact': 'upload-artifact',
  'actions/setup-node': 'setup-node',
  'forge/setup-node': 'setup-node',
};

async function executeAction(
  job: Job,
  step: JobStep,
  containerName: string,
  log: LogBuffer,
  deadline: number,
): Promise<RunResult> {
  const named = step.uses!.split('@')[0]!;
  const action = ACTION_ALIASES[named] ?? named;

  if (action === 'checkout') {
    log.write('Der Quelltext wurde bereits vor dem Start des Containers ausgecheckt.\n');
    return { exitCode: 0, timedOut: false };
  }

  if (action === 'setup-node') {
    return setupNode(step, containerName, log, deadline);
  }

  if (action === 'upload-artifact') {
    const path = step.with.path ?? '.';
    const name = step.with.name ?? 'artifact';
    log.write(`Artefakt "${name}" wird aus ${path} gesammelt.\n`);

    return runProcess(
      'docker',
      [
        'exec',
        '--workdir',
        '/workspace',
        containerName,
        '/usr/bin/sh',
        '-c',
        `mkdir -p /artifacts/${name} && cp -r ${path} /artifacts/${name}/ 2>&1`,
      ],
      { timeoutMs: Math.max(deadline - Date.now(), 1000), onOutput: (chunk) => log.write(chunk) },
    );
  }

  log.write(
    `Die Aktion "${step.uses}" ist auf dieser Instanz nicht verfügbar.\n` +
      'Es gibt keinen Marktplatz: Aktionen sind fest im Runner umgesetzt.\n' +
      'Unterstützt werden actions/checkout, actions/setup-node und\n' +
      'actions/upload-artifact (auch unter forge/).\n' +
      'Alles andere schreibst du als "run"-Schritt.\n',
  );
  return { exitCode: 1, timedOut: false };
}

/**
 * Setzt eine bestimmte Node-Version im Container.
 *
 * Entspricht `actions/setup-node`: Ist die gewünschte Hauptversion schon
 * vorhanden, passiert nichts. Sonst wird die offizielle Binärdistribution
 * nach /usr/local entpackt – derselbe Weg, den die Vorlage bei GitHub geht.
 *
 * Dafür braucht der Container Netzzugang. Läuft der Job mit abgeschaltetem
 * Netz, schlägt der Schritt mit einer Meldung fehl, die genau das sagt,
 * statt mit einem rohen curl-Fehler.
 */
async function setupNode(
  step: JobStep,
  containerName: string,
  log: LogBuffer,
  deadline: number,
): Promise<RunResult> {
  const requested = String(step.with['node-version'] ?? '').trim();

  if (!requested) {
    log.write('Ohne "node-version" bleibt die Version des Images bestehen.\n');
    return { exitCode: 0, timedOut: false };
  }

  // Nur die Hauptversion ist hier sinnvoll zu behandeln; Bereichsangaben wie
  // ">=18" lassen sich ohne Auflösung gegen die Versionsliste nicht abbilden.
  const major = /^\d+/.exec(requested)?.[0];
  if (!major) {
    log.write(
      `Die Angabe "${requested}" wird nicht verstanden. Erwartet wird eine Versionsnummer wie 20 oder 20.11.1.\n`,
    );
    return { exitCode: 1, timedOut: false };
  }

  const timeoutMs = () => Math.max(deadline - Date.now(), 1000);

  // runProcess sammelt keine Ausgabe, sondern reicht sie durch; für die
  // Versionsabfrage wird sie hier eingefangen statt ins Protokoll geschrieben.
  let versionOutput = '';
  await runProcess(
    'docker',
    ['exec', containerName, '/usr/bin/sh', '-c', 'node --version 2>/dev/null || true'],
    { timeoutMs: timeoutMs(), onOutput: (chunk) => (versionOutput += chunk) },
  );

  const installed = versionOutput.trim();
  const current = /v(\d+)/.exec(installed)?.[1];
  if (current === major) {
    log.write(`Node ${installed} ist bereits vorhanden.\n`);
    return { exitCode: 0, timedOut: false };
  }

  log.write(`Node ${requested} wird eingerichtet (vorhanden: ${installed || 'keines'}).\n`);

  // exact=1 lädt genau diese Version, sonst die neueste der Hauptversion.
  const exact = /^\d+\.\d+\.\d+$/.test(requested);
  const script = exact
    ? `V=${requested}`
    : `V=$(curl -fsSL https://nodejs.org/dist/index.json | ` +
      `grep -o '"version":"v${major}\\.[0-9.]*"' | head -1 | cut -d'"' -f4 | tr -d v)`;

  const install = await runProcess(
    'docker',
    [
      'exec',
      containerName,
      '/usr/bin/sh',
      '-c',
      `set -e; ${script}; ` +
        `test -n "$V" || { echo "Keine passende Node-Version gefunden."; exit 1; }; ` +
        `ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "Nicht unterstützte Architektur $ARCH"; exit 1;; esac; ` +
        `curl -fsSL "https://nodejs.org/dist/v$V/node-v$V-linux-$A.tar.xz" | tar -xJ -C /usr/local --strip-components=1; ` +
        `node --version`,
    ],
    { timeoutMs: timeoutMs(), onOutput: (chunk) => log.write(chunk) },
  );

  if (install.exitCode !== 0) {
    log.write(
      'Das Einrichten ist fehlgeschlagen. Häufigste Ursache: der Job läuft ohne\n' +
        'Netzzugang, dann ist nodejs.org nicht erreichbar. Entweder Netz erlauben\n' +
        'oder ein Image verwenden, in dem die Version schon steckt.\n',
    );
  }

  return install;
}

/** Packt gesammelte Artefakte und lädt sie hoch. */
async function uploadArtifacts(job: Job, artifactDir: string, log: LogBuffer): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch {
    return;
  }

  if (entries.length === 0) return;

  for (const name of entries) {
    const archivePath = join(artifactDir, `${name}.tar.gz`);
    const result = await runProcess('tar', ['-czf', archivePath, '-C', artifactDir, name]);

    if (result.exitCode !== 0) {
      log.write(`Artefakt "${name}" konnte nicht gepackt werden.\n`);
      continue;
    }

    try {
      const info = await stat(archivePath);
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(archivePath);

      await api(`/api/v1/runner/jobs/${job.jobId}/artifacts`, undefined, content, {
        'x-forge-artifact-name': `${name}.tar.gz`,
      });

      log.write(`✓ Artefakt "${name}.tar.gz" hochgeladen (${info.size} Bytes).\n`);
    } catch (error) {
      log.write(`Artefakt "${name}" konnte nicht hochgeladen werden: ${String(error)}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hauptschleife
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { platform, arch } = process;

  console.log(`Forge Runner startet. API: ${API_URL}, Labels: ${LABELS.join(', ')}`);

  // Prüfen, dass Docker erreichbar ist – sonst scheitert jeder Job einzeln
  // und der Grund steht nur in den Joblogs.
  const dockerCheck = await runProcess('docker', ['version', '--format', '{{.Server.Version}}']);
  if (dockerCheck.exitCode !== 0) {
    console.error('Docker ist nicht erreichbar. Der Runner kann keine Jobs ausführen.');
    process.exit(1);
  }

  const session = await api<{ runnerId: string; name: string; pollIntervalMs: number }>(
    '/api/v1/runner/session',
    { osName: platform, architecture: arch, version: '0.1.0', labels: LABELS },
  ).catch((error) => {
    console.error('Anmeldung fehlgeschlagen:', error.message);
    process.exit(1);
  });

  console.log(`Angemeldet als "${session.name}".`);

  let running = true;
  const shutdown = () => {
    console.log('Beende nach dem aktuellen Job…');
    running = false;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    try {
      const result = await api<{ job: Job | null }>('/api/v1/runner/jobs/claim');

      if (result.job) {
        console.log(`Job übernommen: ${result.job.name} (${result.job.repositoryFullName})`);
        await executeJob(result.job);
        console.log('Job abgeschlossen.');
        continue;
      }
    } catch (error) {
      console.error('Fehler beim Abholen:', error instanceof Error ? error.message : error);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log('Runner beendet.');
}

main().catch((error) => {
  console.error('Runner abgestürzt:', error);
  process.exit(1);
});

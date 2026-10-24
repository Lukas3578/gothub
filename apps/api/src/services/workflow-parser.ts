/**
 * Parser und Validierung für Workflow-Dateien.
 *
 * Die Dateien kommen aus Repositories, also von außen. Deshalb wird jede
 * Struktur geprüft, bevor daraus ein Lauf entsteht: eine fehlerhafte Datei
 * soll eine verständliche Meldung erzeugen und nicht erst beim Ausführen
 * auffallen.
 *
 * Die Syntax lehnt sich bewusst an die verbreitete YAML-Form an, damit
 * bestehende Kenntnisse übertragbar sind. Sie ist aber nicht identisch und
 * gibt auch nicht vor, es zu sein – nicht unterstützte Schlüssel führen zu
 * einem klaren Hinweis statt stillschweigend ignoriert zu werden.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Ein Schritt führt entweder ein Kommando aus oder nutzt eine Aktion. */
const stepSchema = z
  .object({
    name: z.string().max(255).optional(),
    run: z.string().max(100_000).optional(),
    uses: z.string().max(255).optional(),
    with: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    env: z.record(z.string()).optional(),
    'working-directory': z.string().max(500).optional(),
    'continue-on-error': z.boolean().optional(),
    shell: z.enum(['sh', 'bash']).optional(),
    if: z.string().max(500).optional(),
  })
  .refine((step) => Boolean(step.run) !== Boolean(step.uses), {
    message: 'Ein Schritt braucht entweder "run" oder "uses", nicht beides und nicht keines.',
  });

const triggerBranchFilter = z
  .object({
    branches: z.array(z.string().max(255)).max(50).optional(),
    'branches-ignore': z.array(z.string().max(255)).max(50).optional(),
    paths: z.array(z.string().max(500)).max(50).optional(),
    'paths-ignore': z.array(z.string().max(500)).max(50).optional(),
    tags: z.array(z.string().max(255)).max(50).optional(),
  })
  .optional();

const onSchema = z.union([
  // on: push
  z.string(),
  // on: [push, pull_request]
  z.array(z.string()).max(10),
  // on: { push: { branches: [main] } }
  z.object({
    push: z.union([triggerBranchFilter, z.null()]).optional(),
    pull_request: z.union([triggerBranchFilter, z.null()]).optional(),
    workflow_dispatch: z
      .union([
        z.null(),
        z.object({
          inputs: z
            .record(
              z.object({
                description: z.string().max(500).optional(),
                required: z.boolean().optional(),
                default: z.union([z.string(), z.number(), z.boolean()]).optional(),
                type: z.enum(['string', 'boolean', 'number', 'choice']).optional(),
                options: z.array(z.string().max(255)).max(20).optional(),
              }),
            )
            .optional(),
        }),
      ])
      .optional(),
    schedule: z.array(z.object({ cron: z.string().max(100) })).max(10).optional(),
    release: z.union([z.null(), z.object({ types: z.array(z.string()).optional() })]).optional(),
  }),
]);

const jobSchema = z.object({
  name: z.string().max(255).optional(),
  'runs-on': z.union([z.string().max(255), z.array(z.string().max(255)).max(10)]),
  needs: z.union([z.string().max(255), z.array(z.string().max(255)).max(20)]).optional(),
  if: z.string().max(500).optional(),
  env: z.record(z.string()).optional(),
  'timeout-minutes': z.number().int().min(1).max(360).optional(),
  'continue-on-error': z.boolean().optional(),
  container: z
    .union([
      z.string().max(255),
      z.object({
        image: z.string().max(255),
        env: z.record(z.string()).optional(),
        options: z.string().max(500).optional(),
      }),
    ])
    .optional(),
  steps: z.array(stepSchema).min(1).max(100),
});

const workflowSchema = z.object({
  name: z.string().max(255).optional(),
  on: onSchema,
  env: z.record(z.string()).optional(),
  jobs: z.record(jobSchema),
});

export type RawWorkflow = z.infer<typeof workflowSchema>;

// ---------------------------------------------------------------------------
// Normalisierte Form
// ---------------------------------------------------------------------------

export interface NormalizedStep {
  name: string;
  run: string | null;
  uses: string | null;
  with: Record<string, string>;
  env: Record<string, string>;
  workingDirectory: string | null;
  continueOnError: boolean;
  shell: 'sh' | 'bash';
  if: string | null;
}

export interface NormalizedJob {
  key: string;
  name: string;
  runsOn: string[];
  needs: string[];
  if: string | null;
  env: Record<string, string>;
  timeoutMinutes: number;
  continueOnError: boolean;
  image: string;
  containerEnv: Record<string, string>;
  steps: NormalizedStep[];
}

export interface NormalizedTriggers {
  push: { branches: string[]; branchesIgnore: string[]; paths: string[]; pathsIgnore: string[]; tags: string[] } | null;
  pullRequest: { branches: string[]; branchesIgnore: string[] } | null;
  workflowDispatch: {
    inputs: Record<
      string,
      { description: string | null; required: boolean; default: string | null; type: string; options: string[] }
    >;
  } | null;
  schedules: string[];
  release: boolean;
}

export interface NormalizedWorkflow {
  name: string;
  triggers: NormalizedTriggers;
  env: Record<string, string>;
  jobs: NormalizedJob[];
}

export class WorkflowParseError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'WorkflowParseError';
    this.details = details;
  }
}

/**
 * Standard-Image, wenn ein Job keines angibt.
 *
 * Es wird absichtlich kein Name wie "ubuntu-latest" auf ein echtes
 * Ubuntu-Image abgebildet, ohne dass es vorhanden ist – sonst schlüge der Lauf
 * mit einem unverständlichen Docker-Fehler fehl. Stattdessen gibt es feste
 * Zuordnungen und einen klaren Fehler für Unbekanntes.
 */
export const RUNNER_IMAGE_MAP: Record<string, string> = {
  'ubuntu-latest': 'forge/runner-base:latest',
  'ubuntu-22.04': 'forge/runner-base:latest',
  'forge-base': 'forge/runner-base:latest',
  'self-hosted': 'forge/runner-base:latest',
};

export const DEFAULT_IMAGE = 'forge/runner-base:latest';

// ---------------------------------------------------------------------------
// Parsen
// ---------------------------------------------------------------------------

export function parseWorkflow(source: string, path: string): NormalizedWorkflow {
  let document: unknown;

  try {
    document = parseYaml(source, { prettyErrors: true });
  } catch (error) {
    throw new WorkflowParseError(
      `${path}: Die Datei ist kein gültiges YAML.`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (document === null || typeof document !== 'object') {
    throw new WorkflowParseError(`${path}: Die Datei ist leer oder enthält kein Objekt.`);
  }

  const parsed = workflowSchema.safeParse(document);
  if (!parsed.success) {
    throw new WorkflowParseError(
      `${path}: Die Struktur ist ungültig.`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(Wurzel)'}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const jobKeys = Object.keys(raw.jobs);

  if (jobKeys.length === 0) {
    throw new WorkflowParseError(`${path}: Es ist kein Job definiert.`);
  }

  const jobs: NormalizedJob[] = jobKeys.map((key) => normalizeJob(key, raw.jobs[key]!, path));

  // Abhängigkeiten prüfen: ein Verweis auf einen nicht existierenden Job würde
  // sonst dazu führen, dass der Job nie startet und der Lauf ewig hängt.
  const known = new Set(jobKeys);
  for (const job of jobs) {
    for (const dependency of job.needs) {
      if (!known.has(dependency)) {
        throw new WorkflowParseError(
          `${path}: Job "${job.key}" verweist über "needs" auf den unbekannten Job "${dependency}".`,
        );
      }
    }
  }

  detectCycle(jobs, path);

  return {
    name: raw.name ?? path.split('/').pop() ?? 'Workflow',
    triggers: normalizeTriggers(raw.on),
    env: raw.env ?? {},
    jobs,
  };
}

/**
 * Findet Zyklen im Abhängigkeitsgraphen.
 *
 * Ohne diese Prüfung bliebe ein Lauf mit zirkulärer Abhängigkeit dauerhaft in
 * der Warteschlange, ohne dass jemand erkennt, warum.
 */
function detectCycle(jobs: NormalizedJob[], path: string): void {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (key: string, stack: string[]): void => {
    const current = state.get(key);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new WorkflowParseError(
        `${path}: Die Jobs bilden eine zirkuläre Abhängigkeit: ${[...stack, key].join(' → ')}.`,
      );
    }

    state.set(key, 'visiting');
    for (const dependency of byKey.get(key)?.needs ?? []) {
      visit(dependency, [...stack, key]);
    }
    state.set(key, 'done');
  };

  for (const job of jobs) visit(job.key, []);
}

function normalizeJob(key: string, job: z.infer<typeof jobSchema>, path: string): NormalizedJob {
  const runsOn = Array.isArray(job['runs-on']) ? job['runs-on'] : [job['runs-on']];

  let image = DEFAULT_IMAGE;
  let containerEnv: Record<string, string> = {};

  if (job.container) {
    if (typeof job.container === 'string') {
      image = job.container;
    } else {
      image = job.container.image;
      containerEnv = job.container.env ?? {};
    }
  } else {
    // Ohne ausdrückliches Container-Image wird das Label herangezogen.
    const mapped = runsOn.map((label) => RUNNER_IMAGE_MAP[label]).find(Boolean);
    image = mapped ?? DEFAULT_IMAGE;
  }

  return {
    key,
    name: job.name ?? key,
    runsOn,
    needs: job.needs ? (Array.isArray(job.needs) ? job.needs : [job.needs]) : [],
    if: job.if ?? null,
    env: job.env ?? {},
    timeoutMinutes: job['timeout-minutes'] ?? 60,
    continueOnError: job['continue-on-error'] ?? false,
    image,
    containerEnv,
    steps: job.steps.map((step, index) => normalizeStep(step, index)),
  };
}

function normalizeStep(step: z.infer<typeof stepSchema>, index: number): NormalizedStep {
  const withValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.with ?? {})) {
    withValues[key] = String(value);
  }

  return {
    name: step.name ?? (step.run ? `Schritt ${index + 1}` : (step.uses ?? `Schritt ${index + 1}`)),
    run: step.run ?? null,
    uses: step.uses ?? null,
    with: withValues,
    env: step.env ?? {},
    workingDirectory: step['working-directory'] ?? null,
    continueOnError: step['continue-on-error'] ?? false,
    shell: step.shell ?? 'sh',
    if: step.if ?? null,
  };
}

function normalizeTriggers(on: z.infer<typeof onSchema>): NormalizedTriggers {
  const result: NormalizedTriggers = {
    push: null,
    pullRequest: null,
    workflowDispatch: null,
    schedules: [],
    release: false,
  };

  const emptyPush = { branches: [], branchesIgnore: [], paths: [], pathsIgnore: [], tags: [] };

  if (typeof on === 'string') {
    if (on === 'push') result.push = { ...emptyPush };
    if (on === 'pull_request') result.pullRequest = { branches: [], branchesIgnore: [] };
    if (on === 'workflow_dispatch') result.workflowDispatch = { inputs: {} };
    if (on === 'release') result.release = true;
    return result;
  }

  if (Array.isArray(on)) {
    for (const event of on) {
      if (event === 'push') result.push = { ...emptyPush };
      if (event === 'pull_request') result.pullRequest = { branches: [], branchesIgnore: [] };
      if (event === 'workflow_dispatch') result.workflowDispatch = { inputs: {} };
      if (event === 'release') result.release = true;
    }
    return result;
  }

  if (on.push !== undefined) {
    const filter = on.push ?? {};
    result.push = {
      branches: filter.branches ?? [],
      branchesIgnore: filter['branches-ignore'] ?? [],
      paths: filter.paths ?? [],
      pathsIgnore: filter['paths-ignore'] ?? [],
      tags: filter.tags ?? [],
    };
  }

  if (on.pull_request !== undefined) {
    const filter = on.pull_request ?? {};
    result.pullRequest = {
      branches: filter.branches ?? [],
      branchesIgnore: filter['branches-ignore'] ?? [],
    };
  }

  if (on.workflow_dispatch !== undefined) {
    const dispatch = on.workflow_dispatch ?? {};
    const inputs: NormalizedTriggers['workflowDispatch'] = { inputs: {} };

    for (const [key, value] of Object.entries(
      (dispatch as { inputs?: Record<string, any> }).inputs ?? {},
    )) {
      inputs.inputs[key] = {
        description: value.description ?? null,
        required: value.required ?? false,
        default: value.default !== undefined ? String(value.default) : null,
        type: value.type ?? 'string',
        options: value.options ?? [],
      };
    }
    result.workflowDispatch = inputs;
  }

  if (on.schedule) {
    result.schedules = on.schedule.map((entry) => entry.cron);
  }

  if (on.release !== undefined) result.release = true;

  return result;
}

// ---------------------------------------------------------------------------
// Filter auswerten
// ---------------------------------------------------------------------------

/** Glob-Vergleich für Branch- und Pfadmuster. */
export function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Entscheidet, ob ein Push den Workflow auslöst.
 *
 * Regeln: ohne Branch-Filter zählt jeder Branch. Ein Ausschluss schlägt eine
 * Aufnahme. Pfad-Filter greifen nur, wenn die Liste der geänderten Dateien
 * bekannt ist.
 */
export function pushTriggerMatches(
  trigger: NormalizedTriggers['push'],
  context: { branch: string | null; tag: string | null; changedPaths: string[] | null },
): boolean {
  if (!trigger) return false;

  if (context.tag) {
    if (trigger.tags.length === 0) return false;
    return trigger.tags.some((pattern) => globMatch(context.tag!, pattern));
  }

  if (!context.branch) return false;

  // Ein Workflow, der nur auf Tags hört, soll nicht bei jedem Branch-Push laufen.
  if (trigger.tags.length > 0 && trigger.branches.length === 0 && trigger.branchesIgnore.length === 0) {
    return false;
  }

  if (trigger.branchesIgnore.some((pattern) => globMatch(context.branch!, pattern))) return false;
  if (trigger.branches.length > 0) {
    if (!trigger.branches.some((pattern) => globMatch(context.branch!, pattern))) return false;
  }

  if (context.changedPaths) {
    if (trigger.pathsIgnore.length > 0) {
      const allIgnored = context.changedPaths.every((path) =>
        trigger.pathsIgnore.some((pattern) => globMatch(path, pattern)),
      );
      if (allIgnored) return false;
    }
    if (trigger.paths.length > 0) {
      const anyMatch = context.changedPaths.some((path) =>
        trigger.paths.some((pattern) => globMatch(path, pattern)),
      );
      if (!anyMatch) return false;
    }
  }

  return true;
}

export function pullRequestTriggerMatches(
  trigger: NormalizedTriggers['pullRequest'],
  baseBranch: string,
): boolean {
  if (!trigger) return false;
  if (trigger.branchesIgnore.some((pattern) => globMatch(baseBranch, pattern))) return false;
  if (trigger.branches.length === 0) return true;
  return trigger.branches.some((pattern) => globMatch(baseBranch, pattern));
}

// ---------------------------------------------------------------------------
// Ausdrücke
// ---------------------------------------------------------------------------

/**
 * Wertet einen `if`-Ausdruck aus.
 *
 * Bewusst stark eingeschränkt: unterstützt werden Vergleiche auf
 * Kontextwerte, die Funktionen success() und failure() sowie Verknüpfung mit
 * && und ||. Ein vollwertiger Ausdrucksinterpreter wäre eine eigene
 * Angriffsfläche; was hier nicht verstanden wird, gilt als wahr und wird
 * protokolliert.
 */
export function evaluateCondition(
  expression: string | null,
  context: { success: boolean; variables: Record<string, string> },
): boolean {
  if (!expression) return true;

  const trimmed = expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');

  // Verknüpfungen zuerst zerlegen, damit die Teile einzeln ausgewertet werden.
  if (trimmed.includes('&&')) {
    return trimmed.split('&&').every((part) => evaluateCondition(part, context));
  }
  if (trimmed.includes('||')) {
    return trimmed.split('||').some((part) => evaluateCondition(part, context));
  }

  const normalized = trimmed.trim();

  if (normalized === 'success()') return context.success;
  if (normalized === 'failure()') return !context.success;
  if (normalized === 'always()') return true;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(normalized);
  if (comparison) {
    const left = resolveValue(comparison[1]!.trim(), context.variables);
    const right = resolveValue(comparison[3]!.trim(), context.variables);
    return comparison[2] === '==' ? left === right : left !== right;
  }

  // Unbekannte Ausdrücke blockieren den Lauf nicht.
  return true;
}

function resolveValue(token: string, variables: Record<string, string>): string {
  const unquoted = /^'(.*)'$/.exec(token) ?? /^"(.*)"$/.exec(token);
  if (unquoted) return unquoted[1]!;
  return variables[token] ?? token;
}

/**
 * Ersetzt `${{ ... }}`-Platzhalter in einem Text.
 *
 * Secrets werden hier NICHT eingesetzt: sie gelangen ausschließlich über
 * Umgebungsvariablen in den Container, damit sie nicht im gespeicherten
 * Kommandotext und damit im Log landen.
 */
export function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match, expression: string) => {
    const key = expression.trim();
    if (key.startsWith('secrets.')) {
      // Der Platzhalter bleibt stehen; die Shell löst ihn aus der Umgebung auf.
      return `\${${key.replace('secrets.', 'FORGE_SECRET_')}}`;
    }
    return variables[key] ?? '';
  });
}

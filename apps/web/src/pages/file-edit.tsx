/**
 * Dateien im Browser anlegen, bearbeiten, hochladen und löschen.
 *
 * Alle vier Wege enden an derselben Stelle: einem Commit auf einem Branch.
 * Deshalb teilen sie sich die Commit-Leiste – sie entscheidet, ob direkt auf
 * den Branch geschrieben wird oder ein neuer Branch entsteht.
 *
 * Für einen geschützten Branch weist der Server das direkte Schreiben ab. Die
 * Oberfläche bietet in diesem Fall den neuen Branch an, statt den Benutzer in
 * eine Fehlermeldung laufen zu lassen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { BlobContent, BranchInfo, RepositoryDetail } from '@forge/shared';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import {
  Alert,
  Button,
  ErrorBox,
  Input,
  Panel,
  Spin,
  Textarea,
  cx,
  formatBytes,
} from '../components/ui.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { Markdown } from '../components/Markdown.js';

// ---------------------------------------------------------------------------
// Gemeinsames
// ---------------------------------------------------------------------------

/** Obergrenze je Commit; dieselbe Zahl wie im Server. */
const MAX_COMMIT_BYTES = 6 * 1024 * 1024;

interface CommitTarget {
  /** Direkt auf den Ausgangsbranch oder auf einen neuen Branch. */
  mode: 'direct' | 'branch';
  newBranch: string;
  message: string;
  description: string;
}

function useCommitTarget(suggestion: string): [CommitTarget, (patch: Partial<CommitTarget>) => void] {
  const [state, setState] = useState<CommitTarget>({
    mode: 'direct',
    newBranch: suggestion,
    message: '',
    description: '',
  });

  const patch = useCallback((next: Partial<CommitTarget>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  return [state, patch];
}

/**
 * Die Leiste unter dem Editor: Commit-Nachricht und Zielbranch.
 */
function CommitBar({
  repo,
  branch,
  target,
  patch,
  busy,
  disabled,
  submitLabel,
  placeholder,
  onCancel,
}: {
  repo: RepositoryDetail;
  branch: string;
  target: CommitTarget;
  patch: (next: Partial<CommitTarget>) => void;
  busy: boolean;
  disabled?: boolean;
  submitLabel: string;
  placeholder: string;
  onCancel: () => void;
}) {
  const { viewer } = useSession();

  return (
    <Panel title="Änderung committen" bodyClassName="space-y-4 p-4">
      <Input
        label="Commit-Nachricht"
        name="message"
        value={target.message}
        onChange={(event) => patch({ message: event.target.value })}
        placeholder={placeholder}
        maxLength={2000}
      />

      <Textarea
        label="Weitere Beschreibung (optional)"
        name="description"
        rows={3}
        value={target.description}
        onChange={(event) => patch({ description: event.target.value })}
        placeholder="Was sich geändert hat und warum."
      />

      <fieldset className="space-y-2 border-t border-line pt-4">
        <legend className="sr-only">Zielbranch</legend>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="target"
            checked={target.mode === 'direct'}
            onChange={() => patch({ mode: 'direct' })}
            className="mt-0.5 accent-[rgb(var(--accent))]"
          />
          <span>
            <span className="block text-sm">
              Direkt auf <code className="code">{branch}</code> committen
            </span>
            <span className="block text-2xs text-faint">
              Die Änderung ist sofort im Branch.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="target"
            checked={target.mode === 'branch'}
            onChange={() => patch({ mode: 'branch' })}
            className="mt-0.5 accent-[rgb(var(--accent))]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm">Neuen Branch anlegen</span>
            <span className="block text-2xs text-faint">
              Für einen Pull Request – oder wenn <code className="code">{branch}</code> geschützt
              ist.
            </span>
          </span>
        </label>

        {target.mode === 'branch' && (
          <div className="pl-6">
            <Input
              label="Name des neuen Branches"
              name="newBranch"
              value={target.newBranch}
              onChange={(event) => patch({ newBranch: event.target.value })}
              hint={`Entsteht aus ${branch}.`}
              required
            />
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={disabled || (target.mode === 'branch' && !target.newBranch.trim())}
        >
          {submitLabel}
        </Button>
        <Button type="button" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        {viewer && (
          <span className="ml-auto text-2xs text-faint">
            Als {viewer.username} &lt;{viewer.email}&gt;
          </span>
        )}
      </div>
    </Panel>
  );
}

/** Baut die Nachricht aus Betreff und optionaler Beschreibung. */
function buildMessage(target: CommitTarget, fallback: string): string {
  const subject = target.message.trim() || fallback;
  const body = target.description.trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** Gemeinsame Felder für beide Schreib-Endpunkte. */
function commitFields(target: CommitTarget, branch: string) {
  return target.mode === 'branch'
    ? { branch: target.newBranch.trim(), startBranch: branch }
    : { branch };
}

/**
 * Nach dem Commit: auf einen neuen Branch gewechselt, also direkt den
 * Pull Request anbieten statt den Benutzer suchen zu lassen.
 */
function afterCommit(
  navigate: ReturnType<typeof useNavigate>,
  repo: RepositoryDetail,
  target: CommitTarget,
  branch: string,
  path: string,
) {
  const base = `/${repo.ownerName}/${repo.name}`;

  if (target.mode === 'branch') {
    const head = target.newBranch.trim();
    navigate(`${base}/pulls/new?head=${encodeURIComponent(head)}&base=${encodeURIComponent(branch)}`);
    return;
  }

  const query = branch === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(branch)}`;
  navigate(path ? `${base}/blob/${path}${query}` : `${base}${query}`);
}

/** Verzeichnisanteil eines Pfads. */
function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Einheitliche Pfadprüfung im Browser.
 *
 * Der Server prüft dasselbe noch einmal – das hier erspart nur den Umweg
 * über eine Fehlermeldung vom Server.
 */
function pathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return 'Gib einen Dateinamen an.';
  if (trimmed.startsWith('/')) return 'Der Pfad darf nicht mit „/" beginnen.';
  if (trimmed.endsWith('/')) return 'Der Pfad muss auf einen Dateinamen enden.';
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'Die Segmente „.” und „..” sind nicht zulässig.';
  }
  if (segments.some((segment) => segment === '')) return 'Doppelte Schrägstriche sind nicht zulässig.';
  if (segments[0] === '.git') return 'Der Ordner .git gehört Git selbst.';
  if (/[\u0000-\u001f]/.test(trimmed)) return 'Steuerzeichen sind im Pfad nicht zulässig.';
  return null;
}

/** Pfad als klickbarer Weg, der letzte Teil als Eingabefeld. */
function PathEditor({
  base,
  value,
  onChange,
  branchQuery,
  readOnly,
}: {
  base: string;
  value: string;
  onChange: (value: string) => void;
  branchQuery: string;
  readOnly?: boolean;
}) {
  const directory = directoryOf(value);
  const name = value.slice(directory ? directory.length + 1 : 0);
  const segments = directory ? directory.split('/') : [];

  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <Link to={`${base}${branchQuery}`} className="link font-semibold">
        {base.split('/').pop()}
      </Link>
      {segments.map((segment, index) => (
        <span key={index} className="flex items-center gap-1">
          <span className="text-faint">/</span>
          <Link
            to={`${base}/tree/${segments.slice(0, index + 1).join('/')}${branchQuery}`}
            className="link"
          >
            {segment}
          </Link>
        </span>
      ))}
      <span className="text-faint">/</span>
      {readOnly ? (
        <span className="font-mono text-sm">{name}</span>
      ) : (
        <input
          value={name}
          onChange={(event) =>
            onChange(directory ? `${directory}/${event.target.value}` : event.target.value)
          }
          placeholder="Dateiname"
          aria-label="Dateiname"
          className="h-8 min-w-[12rem] border border-line-strong bg-surface px-2 font-mono text-sm focus:border-accent"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datei anlegen und bearbeiten
// ---------------------------------------------------------------------------

export function FileEditPage({
  repo,
  mode,
}: {
  repo: RepositoryDetail;
  mode: 'create' | 'edit';
}) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const branch = search.get('ref') ?? repo.defaultBranch;
  const base = `/${repo.ownerName}/${repo.name}`;
  const branchQuery = branch === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(branch)}`;

  // Beim Anlegen ist der Pfad das Zielverzeichnis, beim Bearbeiten die Datei.
  const initialPath = params['*'] ?? '';

  const [path, setPath] = useState(mode === 'create' ? (initialPath ? `${initialPath}/` : '') : initialPath);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(mode === 'edit');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const [target, patch] = useCommitTarget(
    mode === 'create' ? 'neue-datei' : `aenderung-${initialPath.split('/').pop() ?? 'datei'}`,
  );

  // Der Stand, auf dem die Bearbeitung aufsetzt. Verhindert, dass eine
  // zwischenzeitliche Änderung anderer still überschrieben wird.
  const [expectedOid, setExpectedOid] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'edit') return;
    let active = true;

    setLoading(true);
    Promise.all([
      api.get<BlobContent>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/blob/${initialPath}?ref=${encodeURIComponent(branch)}`,
      ),
      api
        .get<{ items: BranchInfo[] }>(`/api/v1/repos/${repo.ownerName}/${repo.name}/branches`)
        .catch(() => ({ items: [] as BranchInfo[] })),
    ])
      .then(([blob, branches]) => {
        if (!active) return;
        if (blob.isBinary) {
          setLoadError(
            new Error('Binärdateien lassen sich hier nicht bearbeiten. Lade die Datei neu hoch.'),
          );
        } else if (blob.tooLarge) {
          setLoadError(new Error('Diese Datei ist zu groß für den Editor.'));
        } else {
          setContent(blob.content ?? '');
        }
        setExpectedOid(branches.items.find((item) => item.name === branch)?.oid ?? null);
      })
      .catch((err) => {
        if (active) setLoadError(err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mode, repo.ownerName, repo.name, initialPath, branch]);

  const problem = pathProblem(path);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (problem) {
      setError(problem);
      return;
    }
    if (bytes > MAX_COMMIT_BYTES) {
      setError(`Die Datei ist ${formatBytes(bytes)} groß – erlaubt sind ${formatBytes(MAX_COMMIT_BYTES)}.`);
      return;
    }

    const cleanPath = path.trim();
    const renamed = mode === 'edit' && cleanPath !== initialPath;

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        ...commitFields(target, branch),
        message: buildMessage(
          target,
          mode === 'create' ? `${cleanPath} angelegt` : `${cleanPath} geändert`,
        ),
        contentBase64: toBase64(content),
      };
      if (renamed) body.newPath = cleanPath;
      // Beim Anlegen gibt es keinen Vorzustand zu schützen.
      if (mode === 'edit' && target.mode === 'direct' && expectedOid) {
        body.expectedOid = expectedOid;
      }

      const writePath = renamed ? initialPath : cleanPath;
      await api.put(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/contents/${writePath}`,
        body,
      );

      afterCommit(navigate, repo, target, branch, cleanPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Der Commit ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ErrorBox error={loadError} />;
  if (loading) return <Spin label="Datei wird geladen…" />;

  return (
    <form onSubmit={submit} className="space-y-4">
      <PathEditor base={base} value={path} onChange={setPath} branchQuery={branchQuery} />

      {error && <Alert tone="danger">{error}</Alert>}

      <Panel
        title={
          <div className="flex items-center gap-1">
            <TabButton active={tab === 'edit'} onClick={() => setTab('edit')}>
              Bearbeiten
            </TabButton>
            {isMarkdown && (
              <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>
                Vorschau
              </TabButton>
            )}
          </div>
        }
        actions={
          <span className="text-2xs text-faint">
            {formatBytes(bytes)} · {content.split('\n').length} Zeilen
          </span>
        }
        bodyClassName=""
      >
        {tab === 'preview' ? (
          <div className="p-6">
            {content.trim() ? (
              <Markdown source={content} />
            ) : (
              <p className="text-sm text-faint">Noch nichts zu sehen.</p>
            )}
          </div>
        ) : (
          <CodeEditor
            value={content}
            onChange={setContent}
            path={path}
            ariaLabel={`Inhalt von ${path || 'der neuen Datei'}`}
          />
        )}
      </Panel>

      <CommitBar
        repo={repo}
        branch={branch}
        target={target}
        patch={patch}
        busy={busy}
        disabled={Boolean(problem)}
        submitLabel="Änderung committen"
        placeholder={mode === 'create' ? `${path || 'Datei'} angelegt` : `${path} geändert`}
        onCancel={() => navigate(-1)}
      />
    </form>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-line-strong bg-surface text-ink'
          : 'border-transparent text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** UTF-8-sicheres Base64 – `btoa` allein scheitert an Umlauten. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Dateien hochladen
// ---------------------------------------------------------------------------

interface PendingFile {
  /** Zielpfad im Repository. */
  path: string;
  file: File;
}

export function FileUploadPage({ repo }: { repo: RepositoryDetail }) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const branch = search.get('ref') ?? repo.defaultBranch;
  const base = `/${repo.ownerName}/${repo.name}`;
  const branchQuery = branch === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(branch)}`;

  const [directory, setDirectory] = useState(params['*'] ?? '');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  const [target, patch] = useCommitTarget('dateien-hochladen');

  const total = files.reduce((sum, entry) => sum + entry.file.size, 0);
  const tooLarge = total > MAX_COMMIT_BYTES;

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const added: PendingFile[] = [];
      for (const file of Array.from(list)) {
        // Beim Ablegen eines Ordners trägt webkitRelativePath die Struktur.
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        added.push({ path: relative || file.name, file });
      }
      setFiles((current) => {
        const merged = [...current];
        for (const entry of added) {
          const index = merged.findIndex((existing) => existing.path === entry.path);
          if (index === -1) merged.push(entry);
          else merged[index] = entry;
        }
        return merged.slice(0, 100);
      });
    },
    [],
  );

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (files.length === 0) {
      setError('Wähle mindestens eine Datei.');
      return;
    }
    if (tooLarge) {
      setError(
        `Zusammen ${formatBytes(total)} – erlaubt sind ${formatBytes(MAX_COMMIT_BYTES)} je Commit. ` +
          'Größere Dateien gehören über git push ins Repository.',
      );
      return;
    }

    const prefix = directory.trim().replace(/^\/+|\/+$/g, '');
    const changes: { path: string; contentBase64: string }[] = [];

    for (const entry of files) {
      const full = prefix ? `${prefix}/${entry.path}` : entry.path;
      const problem = pathProblem(full);
      if (problem) {
        setError(`${full}: ${problem}`);
        return;
      }
      changes.push({ path: full, contentBase64: await fileToBase64(entry.file) });
    }

    setBusy(true);
    try {
      await api.post(`/api/v1/repos/${repo.ownerName}/${repo.name}/contents`, {
        ...commitFields(target, branch),
        message: buildMessage(
          target,
          files.length === 1
            ? `${files[0]!.path} hochgeladen`
            : `${files.length} Dateien hochgeladen`,
        ),
        changes,
      });

      afterCommit(navigate, repo, target, branch, prefix);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Der Upload ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Panel title="Dateien hochladen" bodyClassName="space-y-4 p-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex flex-col items-center justify-center gap-2 border-2 border-dashed px-4 py-10 text-center transition-colors',
            dragging ? 'border-accent bg-accent/5' : 'border-line-strong bg-raised/40',
          )}
        >
          <p className="text-sm">Dateien hierher ziehen</p>
          <p className="text-2xs text-faint">
            oder auswählen · höchstens 100 Dateien, zusammen {formatBytes(MAX_COMMIT_BYTES)}
          </p>
          <Button type="button" onClick={() => picker.current?.click()}>
            Dateien auswählen
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            aria-label="Dateien auswählen"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              // Zurücksetzen, damit dieselbe Datei erneut gewählt werden kann.
              event.target.value = '';
            }}
          />
        </div>

        <Input
          label="Zielverzeichnis (optional)"
          name="directory"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          placeholder="z. B. docs/bilder"
          hint="Leer lassen, um in das Wurzelverzeichnis zu legen."
        />

        {files.length > 0 && (
          <div className="border border-line">
            <div className="flex items-center justify-between border-b border-line bg-raised px-3 py-2">
              <span className="text-xs font-medium">
                {files.length} {files.length === 1 ? 'Datei' : 'Dateien'}
              </span>
              <span className={cx('text-2xs', tooLarge ? 'text-danger' : 'text-faint')}>
                {formatBytes(total)}
              </span>
            </div>
            <ul className="divide-y divide-line">
              {files.map((entry) => (
                <li key={entry.path} className="flex items-center gap-3 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">
                    {directory.trim() ? `${directory.trim().replace(/\/+$/, '')}/` : ''}
                    {entry.path}
                  </code>
                  <span className="shrink-0 text-2xs text-faint">
                    {formatBytes(entry.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFiles(files.filter((other) => other.path !== entry.path))}
                    className="shrink-0 text-2xs text-muted hover:text-danger"
                    aria-label={`${entry.path} entfernen`}
                  >
                    Entfernen
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <CommitBar
        repo={repo}
        branch={branch}
        target={target}
        patch={patch}
        busy={busy}
        disabled={files.length === 0 || tooLarge}
        submitLabel={files.length > 1 ? `${files.length} Dateien committen` : 'Datei committen'}
        placeholder={
          files.length === 1 ? `${files[0]!.path} hochgeladen` : `${files.length} Dateien hochgeladen`
        }
        onCancel={() => navigate(`${base}${branchQuery}`)}
      />
    </form>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} konnte nicht gelesen werden.`));
    reader.onload = () => {
      const result = String(reader.result);
      // Data-URL: alles nach dem Komma ist der Base64-Teil.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Datei löschen
// ---------------------------------------------------------------------------

export function FileDeletePage({ repo }: { repo: RepositoryDetail }) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const path = params['*'] ?? '';
  const branch = search.get('ref') ?? repo.defaultBranch;
  const base = `/${repo.ownerName}/${repo.name}`;
  const branchQuery = branch === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(branch)}`;

  const [content, setContent] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [target, patch] = useCommitTarget(`loesche-${path.split('/').pop() ?? 'datei'}`);

  useEffect(() => {
    api
      .get<BlobContent>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/blob/${path}?ref=${encodeURIComponent(branch)}`,
      )
      .then((blob) => {
        setIsBinary(blob.isBinary);
        setContent(blob.content ?? '');
      })
      .catch(() => setContent(''));
  }, [repo.ownerName, repo.name, path, branch]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.put(`/api/v1/repos/${repo.ownerName}/${repo.name}/contents/${path}`, {
        ...commitFields(target, branch),
        message: buildMessage(target, `${path} gelöscht`),
        contentBase64: null,
      });
      afterCommit(navigate, repo, target, branch, directoryOf(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Das Löschen ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const preview = (content ?? '').split('\n').slice(0, 12);

  return (
    <form onSubmit={submit} className="space-y-4">
      <PathEditor
        base={base}
        value={path}
        onChange={() => {}}
        branchQuery={branchQuery}
        readOnly
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Alert tone="warning" title="Diese Datei wird gelöscht">
        Der Inhalt bleibt in der Historie des Repositories erhalten und lässt sich aus einem
        früheren Commit wiederherstellen. Im Branch <code className="code">{branch}</code> ist die
        Datei danach nicht mehr vorhanden.
      </Alert>

      {content !== null && !isBinary && preview.length > 0 && (
        <Panel title="Vorschau des Inhalts" bodyClassName="overflow-x-auto p-3">
          <pre className="font-mono text-xs leading-5 text-muted">{preview.join('\n')}</pre>
          {(content.split('\n').length ?? 0) > 12 && (
            <p className="mt-2 text-2xs text-faint">…</p>
          )}
        </Panel>
      )}

      <CommitBar
        repo={repo}
        branch={branch}
        target={target}
        patch={patch}
        busy={busy}
        submitLabel="Datei löschen"
        placeholder={`${path} gelöscht`}
        onCancel={() => navigate(`${base}/blob/${path}${branchQuery}`)}
      />
    </form>
  );
}

/**
 * Wiki, Gists, Projektboards und Pakete.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CommitSummary, RepositoryDetail } from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { api, apiUpload } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  Panel,
  Select,
  Spin,
  Textarea,
  cx,
  formatBytes,
  formatNumber,
  languageColor,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';
import { Markdown } from './repository.js';

// ===========================================================================
// Wiki
// ===========================================================================

interface WikiPage {
  slug: string;
  title: string;
  sizeBytes: number;
  updatedAt: string | null;
  lastCommit: CommitSummary | null;
}

export function WikiPage({ repo }: { repo: RepositoryDetail }) {
  const [params, setParams] = useSearchParams();
  const slug = params.get('page');
  const editing = params.get('edit') === '1';

  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  const base = `/api/v1/repos/${repo.ownerName}/${repo.name}/wiki`;
  const canEdit = hasAccess(repo.viewerAccess, 'write');

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ items: WikiPage[] }>(`${base}/pages`, controller.signal)
      .then((data) => setPages(data.items))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [base, version]);

  const openPage = useCallback(
    (next: string | null, edit = false) => {
      const updated = new URLSearchParams(params);
      if (next) updated.set('page', next);
      else updated.delete('page');
      if (edit) updated.set('edit', '1');
      else updated.delete('edit');
      setParams(updated);
    },
    [params, setParams],
  );

  if (error) return <ErrorBox error={error} />;
  if (!pages) return <Spin />;

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <aside>
        <Panel
          title="Seiten"
          actions={
            canEdit && (
              <button
                type="button"
                onClick={() => openPage('Neue-Seite', true)}
                className="text-2xs text-accent hover:underline"
              >
                Neu
              </button>
            )
          }
          bodyClassName="divide-y divide-line"
        >
          {pages.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted">Noch keine Seiten.</p>
          ) : (
            pages.map((page) => (
              <button
                key={page.slug}
                type="button"
                onClick={() => openPage(page.slug)}
                className={cx(
                  'block w-full px-3 py-2 text-left text-xs hover:bg-raised',
                  slug === page.slug ? 'bg-raised font-medium text-ink' : 'text-muted',
                )}
              >
                {page.title}
              </button>
            ))
          )}
        </Panel>
      </aside>

      <div>
        {editing && canEdit ? (
          <WikiEditor
            repo={repo}
            slug={slug ?? 'Neue-Seite'}
            onDone={(next) => {
              setVersion((v) => v + 1);
              openPage(next);
            }}
            onCancel={() => openPage(slug)}
          />
        ) : slug ? (
          <WikiViewer
            repo={repo}
            slug={slug}
            canEdit={canEdit}
            onEdit={() => openPage(slug, true)}
            onDeleted={() => {
              setVersion((v) => v + 1);
              openPage(null);
            }}
          />
        ) : (
          <Panel title="Wiki" bodyClassName="p-6">
            {pages.length === 0 ? (
              <EmptyState
                title="Dieses Wiki ist leer"
                description={
                  canEdit
                    ? 'Lege die erste Seite an. Das Wiki ist ein eigenes Git-Repository und lässt sich auch klonen.'
                    : 'Es wurden noch keine Seiten angelegt.'
                }
                action={
                  canEdit ? (
                    <Button variant="primary" onClick={() => openPage('Startseite', true)}>
                      Erste Seite anlegen
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <p className="text-sm text-muted">Wähle links eine Seite aus.</p>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

function WikiViewer({
  repo,
  slug,
  canEdit,
  onEdit,
  onDeleted,
}: {
  repo: RepositoryDetail;
  slug: string;
  canEdit: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [page, setPage] = useState<{ title: string; content: string; updatedAt: string | null } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError(null);
    api
      .get<{ title: string; content: string; updatedAt: string | null }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/wiki/pages/${encodeURIComponent(slug)}`,
        controller.signal,
      )
      .then(setPage)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repo.ownerName, repo.name, slug]);

  async function remove() {
    if (!confirm(`Seite "${slug}" wirklich löschen?`)) return;
    await api.delete(`/api/v1/repos/${repo.ownerName}/${repo.name}/wiki/pages/${encodeURIComponent(slug)}`);
    onDeleted();
  }

  if (error) return <ErrorBox error={error} />;
  if (!page) return <Spin />;

  return (
    <Panel
      title={page.title}
      actions={
        canEdit && (
          <>
            <Button size="sm" onClick={onEdit}>
              Bearbeiten
            </Button>
            <Button size="sm" variant="danger" onClick={remove}>
              Löschen
            </Button>
          </>
        )
      }
      bodyClassName="p-6"
    >
      {page.updatedAt && (
        <p className="mb-4 text-2xs text-faint">Zuletzt geändert {relativeTime(page.updatedAt)}</p>
      )}
      <Markdown source={page.content} />
    </Panel>
  );
}

function WikiEditor({
  repo,
  slug,
  onDone,
  onCancel,
}: {
  repo: RepositoryDetail;
  slug: string;
  onDone: (slug: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(slug.replace(/-/g, ' '));
  const [content, setContent] = useState('');
  const [message, setMessage] = useState('');
  const [expectedOid, setExpectedOid] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ content: string; currentOid: string | null }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/wiki/pages/${encodeURIComponent(slug)}`,
        controller.signal,
      )
      .then((data) => {
        setContent(data.content);
        setExpectedOid(data.currentOid);
        setLoaded(true);
      })
      .catch(() => {
        // Neue Seite: der Abruf schlägt fehl, das ist der Normalfall.
        api
          .get<{ currentOid: string | null }>(`/api/v1/repos/${repo.ownerName}/${repo.name}/wiki/pages`)
          .then((data) => setExpectedOid(data.currentOid))
          .catch(() => {});
        setLoaded(true);
      });
    return () => controller.abort();
  }, [repo.ownerName, repo.name, slug]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const targetSlug = title.trim().replace(/\s+/g, '-');

    try {
      await api.put(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/wiki/pages/${encodeURIComponent(targetSlug)}`,
        { content, message: message || undefined, expectedOid },
      );
      onDone(targetSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <Spin />;

  return (
    <form onSubmit={save}>
      <Panel
        title="Seite bearbeiten"
        actions={
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="text-2xs text-muted hover:text-ink"
          >
            {preview ? 'Bearbeiten' : 'Vorschau'}
          </button>
        }
        bodyClassName="space-y-4 p-5"
      >
        {error && <Alert tone="danger">{error}</Alert>}

        <Input label="Titel" value={title} onChange={(e) => setTitle(e.target.value)} required />

        {preview ? (
          <div className="min-h-[300px] border border-line bg-canvas p-4">
            <Markdown source={content} />
          </div>
        ) : (
          <Textarea
            label="Inhalt (Markdown)"
            rows={18}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono text-[0.8125rem]"
          />
        )}

        <Input
          label="Änderungsnotiz (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Was wurde geändert?"
        />

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Speichern
          </Button>
          <Button type="button" onClick={onCancel}>
            Abbrechen
          </Button>
        </div>
      </Panel>
    </form>
  );
}

// ===========================================================================
// Gists
// ===========================================================================

interface GistFile {
  filename: string;
  content: string;
  language: string | null;
  sizeBytes: number;
}

interface GistSummary {
  id: string;
  description: string | null;
  isPublic: boolean;
  owner: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  primaryFilename: string | null;
  primaryLanguage: string | null;
  fileCount: number;
  starCount: number;
  viewerHasStarred: boolean;
  createdAt: string;
  updatedAt: string;
  cloneUrl: string;
}

interface GistDetail extends GistSummary {
  files: GistFile[];
  viewerCanEdit: boolean;
}

export function GistListPage() {
  const { owner } = useParams();
  const { viewer } = useSession();
  const [data, setData] = useState<{ items: GistSummary[]; totalCount: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = owner ? `?owner=${encodeURIComponent(owner)}` : '';
    api
      .get<{ items: GistSummary[]; totalCount: number }>(`/api/v1/gists${query}`, controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [owner]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-8">
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!data) return <Spin />;

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {owner ? `Gists von ${owner}` : 'Öffentliche Gists'}
        </h1>
        {viewer && (
          <Link
            to="/gists/new"
            className="flex h-8 items-center border border-accent bg-accent px-3 text-xs font-medium text-accent-ink hover:bg-accent/90"
          >
            Neuer Gist
          </Link>
        )}
      </div>

      <Panel className="mt-4" bodyClassName="divide-y divide-line">
        {data.items.length === 0 ? (
          <EmptyState
            title="Keine Gists"
            description="Ein Gist ist ein kleines Repository für Code-Schnipsel – mit Historie und klonbar."
          />
        ) : (
          data.items.map((gist) => (
            <div key={gist.id} className="px-4 py-3">
              <div className="flex items-start gap-2">
                {gist.owner && <Avatar name={gist.owner.username} size={20} url={gist.owner.avatarUrl} />}
                <div className="min-w-0 flex-1">
                  <Link to={`/gists/${gist.id}`} className="link text-sm font-semibold">
                    {gist.primaryFilename ?? 'Ohne Namen'}
                  </Link>
                  {!gist.isPublic && (
                    <span className="ml-2">
                      <Badge>nicht gelistet</Badge>
                    </span>
                  )}
                  {gist.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{gist.description}</p>
                  )}
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 text-2xs text-faint">
                    {gist.primaryLanguage && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2"
                          style={{ background: languageColor(gist.primaryLanguage) }}
                        />
                        {gist.primaryLanguage}
                      </span>
                    )}
                    <span>
                      {gist.fileCount} {gist.fileCount === 1 ? 'Datei' : 'Dateien'}
                    </span>
                    {gist.starCount > 0 && <span>★ {formatNumber(gist.starCount)}</span>}
                    <span>Geändert {relativeTime(gist.updatedAt)}</span>
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

export function NewGistPage() {
  const navigate = useNavigate();
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [files, setFiles] = useState([{ filename: '', content: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const created = await api.post<{ id: string }>('/api/v1/gists', {
        description: description || null,
        isPublic,
        files: files.filter((file) => file.filename.trim() && file.content),
      });
      navigate(`/gists/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold">Neuer Gist</h1>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <Input
          label="Beschreibung"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Wofür ist dieser Schnipsel?"
        />

        {files.map((file, index) => (
          <Panel
            key={index}
            title={
              <input
                value={file.filename}
                onChange={(e) => {
                  const next = [...files];
                  next[index] = { ...file, filename: e.target.value };
                  setFiles(next);
                }}
                placeholder="dateiname.ts"
                className="h-7 w-64 border border-line-strong bg-canvas px-2 font-mono text-xs focus:border-accent focus:outline-none"
              />
            }
            actions={
              files.length > 1 && (
                <button
                  type="button"
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                  className="text-2xs text-danger hover:underline"
                >
                  Entfernen
                </button>
              )
            }
            bodyClassName="p-0"
          >
            <textarea
              value={file.content}
              onChange={(e) => {
                const next = [...files];
                next[index] = { ...file, content: e.target.value };
                setFiles(next);
              }}
              rows={12}
              className="w-full resize-y bg-canvas p-3 font-mono text-[0.8125rem] focus:outline-none"
              placeholder="Inhalt…"
            />
          </Panel>
        ))}

        <Button type="button" onClick={() => setFiles([...files, { filename: '', content: '' }])}>
          Weitere Datei
        </Button>

        <Panel bodyClassName="space-y-3 p-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="mt-0.5 accent-[rgb(var(--accent))]"
            />
            <span>
              <span className="block font-medium">Öffentlich auflisten</span>
              <span className="block text-xs text-muted">
                Ohne Haken erscheint der Gist in keiner Liste, bleibt aber über seinen Link
                erreichbar. Vertrauliches gehört deshalb nicht in einen Gist.
              </span>
            </span>
          </label>

          <Button type="submit" variant="primary" loading={busy}>
            Gist anlegen
          </Button>
        </Panel>
      </form>
    </div>
  );
}

export function GistDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { viewer } = useSession();
  const [gist, setGist] = useState<GistDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<GistDetail>(`/api/v1/gists/${id}`, controller.signal)
      .then(setGist)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [id, version]);

  async function toggleStar() {
    if (!gist) return;
    await api[gist.viewerHasStarred ? 'delete' : 'put'](`/api/v1/gists/${id}/star`);
    setVersion((v) => v + 1);
  }

  async function remove() {
    if (!confirm('Diesen Gist endgültig löschen?')) return;
    await api.delete(`/api/v1/gists/${id}`);
    navigate('/gists');
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-8">
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!gist) return <Spin />;

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg">
            {gist.owner && (
              <>
                <Avatar name={gist.owner.username} size={20} url={gist.owner.avatarUrl} />
                <Link to={`/${gist.owner.username}`} className="link">
                  {gist.owner.username}
                </Link>
                <span className="text-faint">/</span>
              </>
            )}
            <span className="font-semibold">{gist.primaryFilename}</span>
            {!gist.isPublic && <Badge>nicht gelistet</Badge>}
          </h1>
          {gist.description && <p className="mt-1 text-sm text-muted">{gist.description}</p>}
          <p className="mt-1 text-2xs text-faint">
            Angelegt {relativeTime(gist.createdAt)} · Geändert {relativeTime(gist.updatedAt)}
          </p>
        </div>

        {viewer && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={toggleStar} variant={gist.viewerHasStarred ? 'primary' : 'default'}>
              ★ {formatNumber(gist.starCount)}
            </Button>
            {gist.viewerCanEdit && (
              <Button size="sm" variant="danger" onClick={remove}>
                Löschen
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-stretch">
        <input
          readOnly
          value={gist.cloneUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="h-7 w-[380px] max-w-full border border-line-strong bg-canvas px-2 font-mono text-2xs text-muted focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(gist.cloneUrl)}
          className="h-7 border border-l-0 border-line-strong bg-raised px-2.5 text-2xs font-medium hover:bg-line/60"
        >
          Kopieren
        </button>
      </div>

      <div className="mt-5 space-y-4">
        {gist.files.map((file) => (
          <Panel
            key={file.filename}
            title={<span className="font-mono text-xs">{file.filename}</span>}
            actions={
              <span className="text-2xs text-faint">
                {file.language ?? 'Text'} · {formatBytes(file.sizeBytes)}
              </span>
            }
            bodyClassName="overflow-x-auto"
          >
            <pre className="p-4 font-mono text-[0.8125rem] leading-5">
              <code>{file.content}</code>
            </pre>
          </Panel>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Projektboards
// ===========================================================================

interface BoardCard {
  id: string;
  note: string | null;
  position: number;
  issue: { id: string; number: number | null; title: string | null; state: string | null; kind: string | null } | null;
}

interface BoardColumn {
  id: string;
  name: string;
  position: number;
  isDoneColumn: boolean;
  cards: BoardCard[];
}

interface BoardDetail {
  id: string;
  number: number;
  name: string;
  description: string | null;
  isClosed: boolean;
  viewerCanEdit: boolean;
  columns: BoardColumn[];
}

export function ProjectListPage({ repo }: { repo: RepositoryDetail }) {
  const [data, setData] = useState<{
    items: { id: string; number: number; name: string; description: string | null; cardCount: number }[];
    viewerCanEdit: boolean;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [version, setVersion] = useState(0);

  const base = `/api/v1/repos/${repo.ownerName}/${repo.name}/projects`;

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<typeof data>(base, controller.signal)
      .then(setData)
      .catch(() => setData({ items: [], viewerCanEdit: false }));
    return () => controller.abort();
  }, [base, version]);

  async function create(event: FormEvent) {
    event.preventDefault();
    await api.post(base, { name });
    setName('');
    setCreating(false);
    setVersion((v) => v + 1);
  }

  if (!data) return <Spin />;

  return (
    <div className="space-y-4">
      {data.viewerCanEdit && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Abbrechen' : 'Neues Board'}
          </Button>
        </div>
      )}

      {creating && (
        <form onSubmit={create}>
          <Panel bodyClassName="flex items-end gap-3 p-4">
            <div className="flex-1">
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <Button type="submit" variant="primary">
              Anlegen
            </Button>
          </Panel>
        </form>
      )}

      <Panel title="Projektboards" bodyClassName="divide-y divide-line">
        {data.items.length === 0 ? (
          <EmptyState
            title="Noch keine Boards"
            description="Ein Board gliedert Issues in Spalten – vom Rückstand bis zum Abschluss."
          />
        ) : (
          data.items.map((board) => (
            <Link
              key={board.id}
              to={`/${repo.ownerName}/${repo.name}/projects/${board.number}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-raised"
            >
              <div>
                <span className="text-sm font-medium">{board.name}</span>
                {board.description && <p className="text-xs text-muted">{board.description}</p>}
              </div>
              <span className="text-2xs text-faint">
                {board.cardCount} {board.cardCount === 1 ? 'Karte' : 'Karten'}
              </span>
            </Link>
          ))
        )}
      </Panel>
    </div>
  );
}

export function ProjectBoardPage({ repo }: { repo: RepositoryDetail }) {
  const { number = '' } = useParams();
  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);

  const base = `/api/v1/repos/${repo.ownerName}/${repo.name}/projects/${number}`;

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<BoardDetail>(base, controller.signal)
      .then(setBoard)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [base, version]);

  async function moveCard(cardId: string, columnId: string, afterCardId: string | null) {
    await api.post(`${base}/cards/${cardId}/move`, { columnId, afterCardId });
    setVersion((v) => v + 1);
  }

  async function addCard(columnId: string, text: string) {
    const issueMatch = /^#(\d+)$/.exec(text.trim());
    await api.post(`${base}/columns/${columnId}/cards`, {
      note: issueMatch ? null : text,
      issueNumber: issueMatch ? Number(issueMatch[1]) : null,
    });
    setVersion((v) => v + 1);
  }

  if (error) return <ErrorBox error={error} />;
  if (!board) return <Spin />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{board.name}</h2>
          {board.description && <p className="text-xs text-muted">{board.description}</p>}
        </div>
        <Link to={`/${repo.ownerName}/${repo.name}/projects`} className="text-2xs text-muted hover:text-ink">
          Alle Boards
        </Link>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {board.columns.map((column) => (
          <div
            key={column.id}
            className="w-72 shrink-0"
            onDragOver={(e) => {
              if (board.viewerCanEdit) e.preventDefault();
            }}
            onDrop={() => {
              if (dragging) void moveCard(dragging, column.id, null);
              setDragging(null);
            }}
          >
            <Panel
              title={
                <span className="flex items-center gap-2">
                  {column.name}
                  <span className="text-2xs font-normal text-faint">{column.cards.length}</span>
                </span>
              }
              bodyClassName="space-y-2 p-2"
            >
              {column.cards.map((card) => (
                <div
                  key={card.id}
                  draggable={board.viewerCanEdit}
                  onDragStart={() => setDragging(card.id)}
                  className={cx(
                    'border border-line bg-canvas p-2.5 text-xs',
                    board.viewerCanEdit && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  {card.issue ? (
                    <Link
                      to={`/${repo.ownerName}/${repo.name}/${card.issue.kind === 'pull_request' ? 'pulls' : 'issues'}/${card.issue.number}`}
                      className="block hover:text-accent"
                    >
                      <span className="text-faint">#{card.issue.number}</span> {card.issue.title}
                      {card.issue.state === 'closed' && (
                        <span className="ml-1.5">
                          <Badge tone="danger">geschlossen</Badge>
                        </span>
                      )}
                    </Link>
                  ) : (
                    <span className="whitespace-pre-wrap">{card.note}</span>
                  )}
                </div>
              ))}

              {board.viewerCanEdit && <AddCardForm onAdd={(text) => addCard(column.id, text)} />}
            </Panel>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddCardForm({ onAdd }: { onAdd: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full border border-dashed border-line py-1.5 text-2xs text-muted hover:border-line-strong hover:text-ink"
      >
        + Karte
      </button>
    );
  }

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        await onAdd(text).catch(() => {});
        setText('');
        setBusy(false);
        setOpen(false);
      }}
      className="space-y-1.5"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        placeholder="Notiz oder #42 für ein Issue"
        className="w-full border border-line-strong bg-canvas p-2 text-xs focus:border-accent focus:outline-none"
      />
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Hinzufügen
        </Button>
        <Button type="button" size="sm" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

// ===========================================================================
// Pakete
// ===========================================================================

interface PackageEntry {
  id: string;
  format: string;
  name: string;
  description: string | null;
  visibility: string;
  installCommand: string;
  versions: { version: string; createdAt: string; downloadCount: number; sizeBytes: number }[];
}

export function PackagesPage() {
  const { owner = '' } = useParams();
  const [items, setItems] = useState<PackageEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ items: PackageEntry[] }>(
        `/api/v1/users/${encodeURIComponent(owner)}/packages`,
        controller.signal,
      )
      .then((data) => setItems(data.items))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [owner]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-8">
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!items) return <Spin />;

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <h1 className="text-xl font-semibold">Pakete von {owner}</h1>

      <div className="mt-4 space-y-4">
        {items.length === 0 ? (
          <Panel bodyClassName="">
            <EmptyState
              title="Keine Pakete"
              description="Veröffentliche mit npm publish gegen die Registry dieser Instanz."
            />
          </Panel>
        ) : (
          items.map((entry) => (
            <Panel
              key={entry.id}
              title={<span className="font-mono text-xs">{entry.name}</span>}
              actions={
                <>
                  <Badge>{entry.format}</Badge>
                  {entry.visibility !== 'public' && <Badge tone="warning">privat</Badge>}
                </>
              }
              bodyClassName="space-y-3 p-4"
            >
              {entry.description && <p className="text-sm text-muted">{entry.description}</p>}

              <pre className="overflow-x-auto border border-line bg-raised p-2 font-mono text-2xs">
                <code>{entry.installCommand}</code>
              </pre>

              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line text-left text-2xs uppercase tracking-wide text-faint">
                    <th className="py-1">Version</th>
                    <th className="py-1">Veröffentlicht</th>
                    <th className="py-1 text-right">Größe</th>
                    <th className="py-1 text-right">Downloads</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.versions.map((version) => (
                    <tr key={version.version} className="border-b border-line last:border-b-0">
                      <td className="py-1.5 font-mono">{version.version}</td>
                      <td className="py-1.5 text-muted">{relativeTime(version.createdAt)}</td>
                      <td className="py-1.5 text-right text-muted">{formatBytes(version.sizeBytes)}</td>
                      <td className="py-1.5 text-right text-muted">{formatNumber(version.downloadCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// SSH-Schlüssel (Einstellungen)
// ===========================================================================

interface SshKeyEntry {
  id: string;
  title: string;
  fingerprint: string;
  type: string;
  bits: number | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function SshKeysSettings() {
  const [data, setData] = useState<{ items: SshKeyEntry[]; sshEnabled: boolean } | null>(null);
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: SshKeyEntry[]; sshEnabled: boolean }>('/api/v1/user/ssh-keys')
      .then(setData)
      .catch(() => setData({ items: [], sshEnabled: false }));
  }, [version]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/user/ssh-keys', { title, key });
      setTitle('');
      setKey('');
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hinzufügen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.delete(`/api/v1/user/ssh-keys/${id}`);
    setVersion((v) => v + 1);
  }

  if (!data) return <Spin />;

  return (
    <div className="space-y-4">
      {!data.sshEnabled && (
        <Alert tone="info" title="SSH ist auf dieser Instanz abgeschaltet">
          Hinterlegte Schlüssel bleiben erhalten, greifen aber erst, wenn ein Administrator
          <code className="code mx-1">SSH_ENABLED=true</code> setzt.
        </Alert>
      )}

      <form onSubmit={add}>
        <Panel title="Neuer SSH-Schlüssel" bodyClassName="space-y-4 p-5">
          {error && <Alert tone="danger">{error}</Alert>}

          <p className="text-sm text-muted">
            Inhalt deiner öffentlichen Schlüsseldatei, etwa <code className="code">~/.ssh/id_ed25519.pub</code>.
            Der private Schlüssel bleibt auf deinem Rechner.
          </p>

          <Input
            label="Bezeichnung"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Laptop"
          />
          <Textarea
            label="Öffentlicher Schlüssel"
            rows={4}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="font-mono text-2xs"
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… kommentar"
            required
          />

          <Button type="submit" variant="primary" loading={busy}>
            Schlüssel hinzufügen
          </Button>
        </Panel>
      </form>

      <Panel title="Hinterlegte Schlüssel" bodyClassName="divide-y divide-line">
        {data.items.length === 0 ? (
          <EmptyState title="Noch keine Schlüssel" />
        ) : (
          data.items.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{entry.title}</p>
                <p className="mt-0.5 break-all font-mono text-2xs text-faint">{entry.fingerprint}</p>
                <p className="mt-0.5 text-2xs text-faint">
                  {entry.type}
                  {entry.bits ? ` · ${entry.bits} Bit` : ''} · hinzugefügt{' '}
                  {relativeTime(entry.createdAt)} · zuletzt benutzt{' '}
                  {entry.lastUsedAt ? relativeTime(entry.lastUsedAt) : 'nie'}
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={() => remove(entry.id)}>
                Entfernen
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ===========================================================================
// Avatar (Einstellungen)
// ===========================================================================

export function AvatarSettings() {
  const { viewer, refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      // apiUpload kümmert sich um den CSRF-Token und sendet den rohen Körper.
      // Vorher stand hier ein eigener fetch-Aufruf, der den Token aus
      // document.cookie lesen wollte – was bei getrennten Hosts für Frontend
      // und API nie funktionieren kann.
      await apiUpload('/api/v1/user/avatar', file, file.type || 'application/octet-stream');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await api.delete('/api/v1/user/avatar');
    await refresh();
  }

  return (
    <Panel title="Profilbild" bodyClassName="space-y-4 p-5">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex items-center gap-4">
        <Avatar name={viewer?.username ?? '?'} size={72} url={viewer?.avatarUrl} />
        <div className="space-y-2">
          <label className="inline-flex h-8 cursor-pointer items-center border border-line-strong bg-raised px-3 text-xs font-medium hover:bg-line/60">
            {busy ? 'Wird hochgeladen…' : 'Bild wählen'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          {viewer?.avatarUrl && (
            <Button size="sm" variant="danger" onClick={remove}>
              Entfernen
            </Button>
          )}
          <p className="text-2xs text-faint">
            PNG, JPEG, GIF oder WebP, höchstens 2 MB. SVG ist nicht zulässig, weil es Skripte
            enthalten kann.
          </p>
        </div>
      </div>
    </Panel>
  );
}

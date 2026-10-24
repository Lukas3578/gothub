/**
 * Bausteine, die Issues und Pull Requests gemeinsam nutzen: Verlauf,
 * Kommentarfeld mit Vorschau, Reaktionen und Zustandsanzeigen.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  IssueComment,
  IssueEvent,
  IssueState,
  LabelRef,
  PullRequestReview,
  ReactionSummary,
  TimelineEntry,
  UserRef,
} from '@forge/shared';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Avatar } from './Shell.js';
import { Button, Panel, Textarea, cx, relativeTime } from './ui.js';
import { Markdown } from './Markdown.js';

// ---------------------------------------------------------------------------
// Zustandsanzeige
// ---------------------------------------------------------------------------

export function StateBadge({
  state,
  kind,
  merged,
  isDraft,
}: {
  state: IssueState;
  kind: 'issue' | 'pull_request';
  merged?: boolean;
  isDraft?: boolean;
}) {
  const config = merged
    ? { label: 'Gemergt', className: 'border-[#8957e5] bg-[#8957e5] text-white' }
    : isDraft && state === 'open'
      ? { label: 'Entwurf', className: 'border-line-strong bg-raised text-muted' }
      : state === 'open'
        ? { label: kind === 'issue' ? 'Offen' : 'Offen', className: 'border-success bg-success text-white' }
        : { label: 'Geschlossen', className: 'border-danger bg-danger text-white' };

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium',
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}

export function LabelChip({ label }: { label: LabelRef }) {
  // Die Textfarbe richtet sich nach der Helligkeit der Hintergrundfarbe,
  // damit helle Labels lesbar bleiben.
  const r = parseInt(label.color.slice(0, 2), 16);
  const g = parseInt(label.color.slice(2, 4), 16);
  const b = parseInt(label.color.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  return (
    <span
      className="inline-flex items-center border px-2 py-0.5 text-2xs font-medium"
      style={{
        background: `#${label.color}`,
        borderColor: `#${label.color}`,
        color: luminance > 0.6 ? '#1a1a1c' : '#ffffff',
      }}
      title={label.description ?? undefined}
    >
      {label.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reaktionen
// ---------------------------------------------------------------------------

const REACTION_EMOJI: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
};

export function Reactions({
  reactions,
  onToggle,
  disabled,
}: {
  reactions: ReactionSummary[];
  onToggle: (content: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.content}
          type="button"
          onClick={() => onToggle(reaction.content)}
          disabled={disabled}
          className={cx(
            'flex items-center gap-1 border px-1.5 py-0.5 text-2xs transition-colors',
            reaction.viewerReacted
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-line-strong text-muted hover:bg-raised',
          )}
        >
          <span>{REACTION_EMOJI[reaction.content] ?? reaction.content}</span>
          {reaction.count}
        </button>
      ))}

      {!disabled && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="border border-line-strong px-1.5 py-0.5 text-2xs text-faint hover:bg-raised hover:text-ink"
            aria-label="Reaktion hinzufügen"
          >
            ☺ +
          </button>
          {open && (
            <div className="absolute left-0 top-7 z-20 flex gap-1 border border-line bg-surface p-1 shadow-lg">
              {Object.entries(REACTION_EMOJI).map(([key, emoji]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    onToggle(key);
                    setOpen(false);
                  }}
                  className="px-1 text-sm hover:bg-raised"
                  title={key}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kommentarfeld
// ---------------------------------------------------------------------------

export function CommentEditor({
  value,
  onChange,
  onSubmit,
  submitLabel,
  placeholder,
  busy,
  extraActions,
  minRows = 5,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  placeholder?: string;
  busy?: boolean;
  extraActions?: ReactNode;
  minRows?: number;
}) {
  const [preview, setPreview] = useState(false);

  return (
    <div className="border border-line">
      <div className="flex items-center gap-1 border-b border-line bg-raised px-2 py-1">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={cx(
            'border px-2.5 py-1 text-2xs font-medium',
            !preview ? 'border-line-strong bg-surface text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          Schreiben
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={cx(
            'border px-2.5 py-1 text-2xs font-medium',
            preview ? 'border-line-strong bg-surface text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          Vorschau
        </button>
        <span className="ml-auto text-2xs text-faint">
          Markdown wird unterstützt · @name erwähnt, #12 verweist
        </span>
      </div>

      {preview ? (
        <div className="min-h-[120px] p-4">
          {value.trim() ? (
            <Markdown source={value} />
          ) : (
            <p className="text-sm text-faint">Nichts zu zeigen.</p>
          )}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? 'Schreibe einen Kommentar…'}
          rows={minRows}
          className="w-full resize-y border-0 bg-canvas px-3 py-2.5 font-sans text-sm leading-relaxed text-ink placeholder:text-faint focus:outline-none"
        />
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line bg-raised px-2 py-1.5">
        {extraActions}
        <Button
          size="sm"
          variant="primary"
          onClick={onSubmit}
          loading={busy}
          disabled={!value.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

/**
 * Ein Beitrag im Verlauf, mit der senkrechten Linie links.
 *
 * Ohne diese Linie stehen Eröffnungsbeitrag, Kommentare und Ereignisse als
 * gleichwertige Kästen untereinander, und es ist nicht abzulesen, dass sie
 * eine Abfolge bilden – besonders bei kurzen Ereigniszeilen zwischen langen
 * Kommentaren.
 *
 * Auch der Eröffnungsbeitrag der Seite nutzt diese Hülle, sonst begänne die
 * Linie erst beim zweiten Beitrag und die Spalten stünden versetzt.
 *
 * `last` verkürzt die Linie auf einen Stummel, damit sie nicht ins Leere
 * unter den Verlauf zeigt – etwa in das Kommentarfeld hinein.
 */
export function TimelineItem({
  children,
  last,
}: {
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cx(
        'relative pl-6 before:absolute before:left-[9px] before:top-0 before:w-px before:bg-line',
        last ? 'before:h-6' : 'before:h-[calc(100%+0.75rem)]',
      )}
    >
      {children}
    </div>
  );
}

export function Timeline({
  entries,
  repoPath,
  onReload,
}: {
  entries: TimelineEntry[];
  repoPath: string;
  onReload: () => void;
}) {
  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <TimelineItem
          key={
            entry.type === 'comment'
              ? entry.comment.id
              : entry.type === 'review'
                ? entry.review.id
                : entry.event.id
          }
          last={index === entries.length - 1}
        >
          {entry.type === 'comment' ? (
            <CommentCard comment={entry.comment} repoPath={repoPath} onReload={onReload} />
          ) : entry.type === 'review' ? (
            <ReviewCard review={entry.review} />
          ) : (
            <EventRow event={entry.event} />
          )}
        </TimelineItem>
      ))}
    </div>
  );
}

function CommentCard({
  comment,
  repoPath,
  onReload,
}: {
  comment: IssueComment;
  repoPath: string;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/v1/repos/${repoPath}/issue-comments/${comment.id}`, { body: draft });
      setEditing(false);
      onReload();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Diesen Kommentar löschen?')) return;
    await api.delete(`/api/v1/repos/${repoPath}/issue-comments/${comment.id}`);
    onReload();
  }

  async function toggleReaction(content: string) {
    await api.post(`/api/v1/repos/${repoPath}/reactions/issue_comment/${comment.id}`, { content });
    onReload();
  }

  return (
    <article className="panel">
      <header className="panel-header">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Avatar name={comment.author?.username ?? '?'} size={20} url={comment.author?.avatarUrl} />
          {comment.author ? (
            <Link to={`/${comment.author.username}`} className="font-semibold hover:text-accent">
              {comment.author.username}
            </Link>
          ) : (
            <span className="font-semibold text-muted">Gelöschter Benutzer</span>
          )}
          <span className="text-faint">kommentierte {relativeTime(comment.createdAt)}</span>
          {comment.editedAt && <span className="text-faint">· bearbeitet</span>}
        </div>

        {comment.viewerCanEdit && !editing && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-2xs text-muted hover:text-ink"
            >
              Bearbeiten
            </button>
            <button type="button" onClick={remove} className="text-2xs text-muted hover:text-danger">
              Löschen
            </button>
          </div>
        )}
      </header>

      <div className="p-4">
        {editing ? (
          <div className="space-y-2">
            <CommentEditor
              value={draft}
              onChange={setDraft}
              onSubmit={save}
              submitLabel="Speichern"
              busy={busy}
              extraActions={
                <Button size="sm" onClick={() => setEditing(false)}>
                  Abbrechen
                </Button>
              }
            />
          </div>
        ) : (
          <Markdown source={comment.body} />
        )}
      </div>

      {!editing && (
        <footer className="border-t border-line px-4 py-2">
          <Reactions reactions={comment.reactions} onToggle={toggleReaction} />
        </footer>
      )}
    </article>
  );
}

function ReviewCard({ review }: { review: PullRequestReview }) {
  const stateConfig = {
    approved: { label: 'hat zugestimmt', tone: 'text-success', icon: '✓' },
    changes_requested: { label: 'fordert Änderungen', tone: 'text-danger', icon: '✗' },
    commented: { label: 'hat kommentiert', tone: 'text-muted', icon: '💬' },
    dismissed: { label: 'Review verworfen', tone: 'text-faint', icon: '—' },
    pending: { label: 'Review ausstehend', tone: 'text-faint', icon: '•' },
  } as const;

  const config = stateConfig[review.state];

  return (
    <article className="panel">
      <header className="panel-header">
        <div className="flex items-center gap-2 text-xs">
          <Avatar name={review.reviewer?.username ?? '?'} size={20} url={review.reviewer?.avatarUrl} />
          {review.reviewer && (
            <Link to={`/${review.reviewer.username}`} className="font-semibold hover:text-accent">
              {review.reviewer.username}
            </Link>
          )}
          <span className={cx('font-medium', config.tone)}>
            {config.icon} {config.label}
          </span>
          <span className="text-faint">{relativeTime(review.submittedAt ?? review.createdAt)}</span>
        </div>
      </header>

      {review.body && (
        <div className="p-4">
          <Markdown source={review.body} />
        </div>
      )}

      {review.comments.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {review.comments.map((comment) => (
            <div key={comment.id} className="px-4 py-3">
              <p className="mb-2 font-mono text-2xs text-faint">
                {comment.path}
                {comment.line !== null && `:${comment.line}`}
                {comment.isResolved && <span className="ml-2 text-success">erledigt</span>}
              </p>
              <div className="border-l-2 border-line-strong pl-3">
                <Markdown source={comment.body} />
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/** Beschreibt ein Verlaufsereignis in einem Satz. */
function EventRow({ event }: { event: IssueEvent }) {
  const actor = event.actor?.username ?? 'Jemand';

  const descriptions: Record<string, string> = {
    closed: 'hat dies geschlossen',
    reopened: 'hat dies wieder geöffnet',
    merged: 'hat den Pull Request gemergt',
    labeled: 'hat die Labels geändert',
    assigned: 'hat die Zuständigkeit geändert',
    milestoned: 'hat den Milestone geändert',
    locked: 'hat die Unterhaltung gesperrt',
    unlocked: 'hat die Sperre aufgehoben',
    marked_draft: 'hat dies als Entwurf markiert',
    ready_for_review: 'hat dies zur Prüfung freigegeben',
    review_dismissed: 'hat ein Review verworfen',
    closed_by_pull_request: 'hat dies über einen Pull Request geschlossen',
  };

  const text = descriptions[event.eventType] ?? `hat "${event.eventType}" ausgelöst`;

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted">
      <span className="flex h-5 w-5 items-center justify-center border border-line bg-raised text-2xs text-faint">
        •
      </span>
      {event.actor ? (
        <Link to={`/${event.actor.username}`} className="font-medium hover:text-accent">
          {actor}
        </Link>
      ) : (
        <span className="font-medium">{actor}</span>
      )}
      <span>{text}</span>
      <span className="text-faint">· {relativeTime(event.createdAt)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seitenleiste
// ---------------------------------------------------------------------------

export function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-faint">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function UserList({ users, empty }: { users: UserRef[]; empty: string }) {
  if (users.length === 0) return <p className="text-xs text-faint">{empty}</p>;

  return (
    <ul className="space-y-1.5">
      {users.map((user) => (
        <li key={user.id} className="flex items-center gap-2">
          <Avatar name={user.username} size={18} url={user.avatarUrl} />
          <Link to={`/${user.username}`} className="text-xs hover:text-accent">
            {user.username}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Basiskomponenten der Oberfläche.
 *
 * Alle Varianten werden hier definiert, damit Abstände, Rahmenstärken und
 * Zustände über die ganze Anwendung identisch sind.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 border font-medium transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent border-accent text-accent-ink hover:bg-accent/90 active:bg-accent/80',
  default:
    'bg-raised border-line-strong text-ink hover:bg-line/60 active:bg-line',
  ghost: 'bg-transparent border-transparent text-muted hover:bg-raised hover:text-ink',
  danger: 'bg-transparent border-danger/60 text-danger hover:bg-danger hover:text-white',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-2xs',
  md: 'h-9 px-3.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', loading, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function LinkButton({
  to,
  variant = 'default',
  size = 'md',
  className,
  children,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
    >
      {children}
    </Link>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Formularelemente
// ---------------------------------------------------------------------------

/*
 * Felder stehen meist auf `surface` (weiß im hellen Theme). Ein Feld in
 * `canvas` hob sich dort kaum ab; mit der getönten Leinwand sitzt es jetzt
 * sichtbar vertieft in der Fläche – der Unterschied, an dem man ein
 * Eingabefeld als solches erkennt, bevor man hineinklickt.
 */
const FIELD_BASE =
  'w-full border border-line-strong bg-canvas px-2.5 text-ink placeholder:text-faint ' +
  'transition-colors hover:border-faint ' +
  'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  prefix?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, prefix, className, id, ...props },
  ref,
) {
  const inputId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-muted">
          {label}
          {props.required && <span className="ml-1 text-danger">*</span>}
        </label>
      )}
      <div className={prefix ? 'flex items-stretch' : undefined}>
        {prefix && (
          <span className="flex items-center border border-r-0 border-line-strong bg-raised px-2.5 text-sm text-muted">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cx(FIELD_BASE, 'h-9', error && 'border-danger', className)}
          aria-invalid={Boolean(error)}
          {...props}
        />
      </div>
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...props },
  ref,
) {
  const fieldId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={fieldId} className="block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={fieldId}
        className={cx(FIELD_BASE, 'py-2 leading-relaxed', error && 'border-danger', className)}
        {...props}
      />
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, className, id, children, ...props },
  ref,
) {
  const fieldId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={fieldId} className="block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      {/*
        min-w-0 verhindert, dass der Browser das Feld auf seine Inhaltsbreite
        zwingt; die Mindestbreite sorgt dafür, dass Optionen wie „Zuletzt
        aktualisiert" nicht nach drei Wörtern abgeschnitten werden.
      */}
      <select
        ref={ref}
        id={fieldId}
        className={cx(FIELD_BASE, 'h-9 min-w-[10rem] cursor-pointer pr-8', className)}
        {...props}
      >
        {children}
      </select>
      {hint && <p className="text-xs text-faint">{hint}</p>}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Flächen und Hinweise
// ---------------------------------------------------------------------------

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('panel', className)}>
      {(title || actions) && (
        <header className="panel-header">
          <div className="min-w-0 text-sm font-semibold">{title}</div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'danger' | 'success' | 'warning';
  title?: string;
  children?: ReactNode;
}) {
  const tones = {
    info: 'border-info/50 bg-info/10 text-ink',
    danger: 'border-danger/50 bg-danger/10 text-ink',
    success: 'border-success/50 bg-success/10 text-ink',
    warning: 'border-warning/50 bg-warning/10 text-ink',
  } as const;

  return (
    <div className={cx('border px-3 py-2.5 text-sm', tones[tone])} role="alert">
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-0.5 text-muted' : undefined}>{children}</div>}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'info' | 'warning';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'border-line-strong text-muted',
    accent: 'border-accent/60 text-accent',
    success: 'border-success/60 text-success',
    danger: 'border-danger/60 text-danger',
    info: 'border-info/60 text-info',
    warning: 'border-warning/60 text-warning',
  } as const;

  return <span className={cx('label-chip', tones[tone])}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  /*
   * Ein leerer Zustand soll sagen, dass hier nichts ist – nicht so viel Platz
   * einnehmen wie ein voller. Vorher waren es 56 px Luft oben und unten,
   * wodurch eine leere Liste mehr Fläche belegte als eine mit drei Einträgen.
   */
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {description && <p className="max-w-md text-xs text-faint">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Spin({ label = 'Wird geladen…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
      <Spinner />
      {label}
    </div>
  );
}

/** Zeigt einen Fehler aus dem API-Client lesbar an. */
export function ErrorBox({ error }: { error: unknown }) {
  const message =
    error instanceof Error ? error.message : 'Ein unerwarteter Fehler ist aufgetreten.';
  return (
    <Alert tone="danger" title="Das hat nicht geklappt">
      {message}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Darstellungshilfen
// ---------------------------------------------------------------------------

/** Relative Zeitangabe auf Deutsch. */
export function relativeTime(isoDate: string | null | undefined): string {
  if (!isoDate) return 'nie';
  const date = new Date(isoDate);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 45) return 'gerade eben';
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
    [Infinity, 'year'],
  ];

  const divisors = [1, 60, 3600, 86400, 604800, 2629800, 31557600];
  const formatter = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

  for (let i = 0; i < units.length; i += 1) {
    if (seconds < units[i]![0]) {
      const value = Math.round(seconds / divisors[i]!);
      return formatter.format(-value, units[i]![1]);
    }
  }
  return formatter.format(-Math.round(seconds / 31557600), 'year');
}

/**
 * Einzahl oder Mehrzahl, je nach Anzahl.
 *
 * „1 Commits" und „1 Dateien" standen an etlichen Stellen. Für sich genommen
 * eine Kleinigkeit – in der Summe liest sich eine Oberfläche dadurch
 * unfertig.
 */
export function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('de-DE').format(value);
}

/** Feste Farbe je Sprache, abgeleitet aus dem Namen – stabil ohne Tabelle. */
export function languageColor(language: string | null): string {
  if (!language) return 'rgb(var(--faint))';
  const known: Record<string, string> = {
    TypeScript: '#3178c6',
    JavaScript: '#f1e05a',
    Java: '#b07219',
    Python: '#3572A5',
    Rust: '#dea584',
    Go: '#00ADD8',
    'C++': '#f34b7d',
    C: '#555555',
    'C#': '#178600',
    Ruby: '#701516',
    PHP: '#4F5D95',
    Shell: '#89e051',
    HTML: '#e34c26',
    CSS: '#563d7c',
    Kotlin: '#A97BFF',
    Swift: '#F05138',
    Dart: '#00B4AB',
    Elixir: '#6e4a7e',
    Haskell: '#5e5086',
    Lua: '#000080',
    Vue: '#41b883',
    Svelte: '#ff3e00',
  };
  if (known[language]) return known[language]!;

  // Deterministischer Farbton für alles Übrige.
  let hash = 0;
  for (let i = 0; i < language.length; i += 1) {
    hash = (hash * 31 + language.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 55%)`;
}

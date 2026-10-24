/**
 * Texteditor für Dateien im Repository.
 *
 * Grundlage ist CodeMirror 6. Ein einfaches `<textarea>` wäre weniger Code,
 * aber ohne Zeilennummern, ohne Syntaxhervorhebung, ohne Klammernpaare und
 * ohne vernünftiges Verhalten der Tabulatortaste – für eine Datei mit
 * dreihundert Zeilen ist das der Unterschied zwischen benutzbar und nicht.
 *
 * Das Farbthema wird aus denselben CSS-Variablen gebaut wie die
 * Dateiansicht. Ein fertiges Theme (one-dark und Verwandte) würde ein zweites
 * Farbsystem in die Oberfläche tragen: derselbe Quelltext sähe beim Lesen
 * anders aus als beim Bearbeiten.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  indentUnit,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

/**
 * Sprachmodule werden erst bei Bedarf geladen.
 *
 * Alle zusammen sind rund 400 KB; die meisten Dateien brauchen genau eines.
 */
async function languageFor(path: string): Promise<Extension | null> {
  const name = path.toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  // Dateien ohne Endung, die trotzdem eine bekannte Sprache haben.
  const base = name.split('/').pop() ?? '';
  if (base === 'dockerfile' || base === 'makefile') return null;

  switch (extension) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts':
    case 'mts':
    case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: true,
        jsx: true,
      });
    case 'json':
    case 'jsonc':
      return (await import('@codemirror/lang-json')).json();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
    case 'scss':
    case 'less':
      return (await import('@codemirror/lang-css')).css();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust();
    case 'yml':
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    default:
      return null;
  }
}

/**
 * Farben aus dem Farbsystem der Anwendung.
 *
 * Die Zuordnung entspricht Zeile für Zeile den `.hljs-*`-Regeln in
 * `index.css`, damit Lesen und Bearbeiten gleich aussehen.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'rgb(var(--faint))', fontStyle: 'italic' },
  {
    tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.typeName, tags.tagName],
    color: 'rgb(var(--accent))',
  },
  { tag: [tags.string, tags.special(tags.string), tags.attributeName, tags.propertyName], color: 'rgb(var(--success))' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.variableName, tags.labelName], color: 'rgb(var(--info))' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'rgb(var(--ink))' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'rgb(var(--muted))' },
  { tag: [tags.heading, tags.strong], color: 'rgb(var(--ink))', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'rgb(var(--accent))', textDecoration: 'underline' },
  { tag: [tags.deleted, tags.invalid], color: 'rgb(var(--danger))' },
]);

const theme = EditorView.theme({
  '&': {
    color: 'rgb(var(--ink))',
    backgroundColor: 'rgb(var(--surface))',
    fontSize: '0.8125rem',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    padding: '0.75rem 0',
    caretColor: 'rgb(var(--accent))',
    /*
     * Die Mindesthöhe sitzt am Inhalt, nicht am umgebenden Kasten: CodeMirror
     * richtet die Zeilennummernspalte nach der Inhaltshöhe aus. Läge die Höhe
     * außen, endete die Trennlinie der Spalte nach der letzten Zeile und das
     * Feld wirkte halb gezeichnet.
     */
    minHeight: 'var(--cm-min-height, 420px)',
  },
  '.cm-line': { padding: '0 1rem', lineHeight: '1.5rem' },
  '.cm-gutters': {
    backgroundColor: 'rgb(var(--surface))',
    color: 'rgb(var(--faint))',
    border: 'none',
    borderRight: '1px solid rgb(var(--line))',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.75rem', lineHeight: '1.5rem' },
  '.cm-activeLine': { backgroundColor: 'rgb(var(--raised) / 0.6)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgb(var(--raised) / 0.6)', color: 'rgb(var(--muted))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgb(var(--accent) / 0.25)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--accent))' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgb(var(--accent) / 0.2)',
    outline: 'none',
  },
  '.cm-selectionMatch': { backgroundColor: 'rgb(var(--accent) / 0.15)' },
  // Der Fokusring der Anwendung sitzt am Rahmen, nicht am Editor selbst.
  '&.cm-focused': { outline: 'none' },
});

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Bestimmt die Sprache für die Hervorhebung. */
  path?: string;
  /** Mindesthöhe in Pixeln. */
  minHeight?: number;
  readOnly?: boolean;
  /** Für die Zuordnung von Beschriftungen. */
  ariaLabel?: string;
}

export function CodeEditor({
  value,
  onChange,
  path = '',
  minHeight = 420,
  readOnly = false,
  ariaLabel = 'Dateiinhalt',
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  // Über Referenzen, damit eine Änderung dieser Werte den Editor nicht neu
  // aufbaut: ein Neuaufbau verwirft Cursor, Auswahl und Rückgängig-Historie.
  const latest = useRef(onChange);
  latest.current = onChange;

  /**
   * Der zuletzt vom Editor selbst gemeldete Stand.
   *
   * Ohne diesen Merker entsteht ein Wettlauf: Tippen meldet den neuen Text
   * nach oben, React stellt ihn verzögert als `value` wieder zu, und der
   * Abgleich weiter unten schreibt diesen – inzwischen veralteten – Stand
   * zurück in das Dokument. Dazwischen getippte Zeichen gehen verloren; beim
   * schnellen Tippen wurde aus „MIT. Siehe README." so „MIT. Siehe .".
   */
  const ownValue = useRef(value);

  // Der Anfangswert wird nur beim Aufbau gebraucht. Als Referenz gehalten,
  // damit `value` nicht in den Abhängigkeiten des Aufbaus stehen muss.
  const initial = useRef(value);

  /**
   * Compartment für die Sprache.
   *
   * Die Sprache hängt am Dateinamen, und der ist während des Anlegens ein
   * Eingabefeld: Ohne Compartment würde jeder Tastendruck im Namensfeld den
   * ganzen Editor neu aufbauen.
   */
  const languageSlot = useRef(new Compartment());

  /**
   * Die zuletzt geladene Sprache, zusammen mit dem Pfad, zu dem sie gehört.
   *
   * Das Laden ist asynchron, der Aufbau des Editors nicht. Fällt das Ergebnis
   * zwischen Aufbau und Neuaufbau an – im Entwicklungsmodus montiert React
   * jede Komponente einmal zusätzlich –, landet es an der Instanz, die
   * gleich darauf verworfen wird, und der neue Editor steht ohne Sprache da.
   * Deshalb wird das Ergebnis hier festgehalten und nach jedem Aufbau erneut
   * angelegt.
   */
  const loadedLanguage = useRef<{ path: string; extension: Extension | null } | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle),
      indentUnit.of('  '),
      // indentWithTab zuletzt, damit die Tabulatortaste einrückt statt den
      // Fokus zu verschieben. Mit Escape kommt man weiterhin heraus – sonst
      // wäre der Editor für Tastaturbedienung eine Sackgasse.
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.lineWrapping,
      theme,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      languageSlot.current.of([]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        ownValue.current = text;
        latest.current(text);
      }),
    ];

    const instance = new EditorView({
      state: EditorState.create({ doc: initial.current, extensions }),
      parent: host.current,
    });
    view.current = instance;

    // Eine bereits geladene Sprache sofort wieder anlegen.
    const loaded = loadedLanguage.current;
    if (loaded && loaded.extension) {
      instance.dispatch({ effects: languageSlot.current.reconfigure(loaded.extension) });
    }

    return () => {
      instance.destroy();
      if (view.current === instance) view.current = null;
    };
  }, [readOnly]);

  // Sprache nachladen und im Compartment austauschen.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const language = await languageFor(path);
      if (cancelled) return;

      loadedLanguage.current = { path, extension: language };
      view.current?.dispatch({
        effects: languageSlot.current.reconfigure(language ?? []),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  // Beschriftung für Hilfsmittel; ändert sich mit dem Dateinamen.
  useEffect(() => {
    view.current?.contentDOM.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  /**
   * Wert von außen gesetzt, etwa wenn die Datei fertig geladen ist.
   *
   * Der Fokus entscheidet: Tippt der Benutzer gerade, ist der Editor die
   * Quelle der Wahrheit und ein eintreffender `value` ist bestenfalls so neu
   * wie das Dokument, meistens älter. Ihn dann zu übernehmen, würde Zeichen
   * verschlucken.
   */
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (value === ownValue.current) return;
    if (instance.hasFocus) return;

    const current = instance.state.doc.toString();
    if (current === value) return;

    ownValue.current = value;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      style={{ '--cm-min-height': `${minHeight}px` } as CSSProperties}
      className="overflow-hidden bg-surface focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-accent"
    />
  );
}

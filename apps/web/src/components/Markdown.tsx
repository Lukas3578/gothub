/**
 * Markdown-Darstellung für READMEs, Kommentare und Beschreibungen.
 *
 * Eigene Datei, weil mehrere Seiten sie brauchen: läge sie weiter in
 * repository.tsx, importierten sich Repository-Ansicht und Dateieditor
 * gegenseitig.
 */

import { useMemo } from 'react';
import { marked } from 'marked';

/**
 * Markdown-Darstellung.
 *
 * `marked` erzeugt HTML, das hier eingefügt wird. Damit eingebettetes
 * <script> oder ein onerror-Attribut aus einer README nicht ausgeführt wird,
 * läuft das Ergebnis vorher durch eine Bereinigung über den DOM-Parser.
 */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
    return sanitizeHtml(raw);
  }, [source]);

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

const ALLOWED_TAGS = new Set([
  'A','ABBR','B','BLOCKQUOTE','BR','CODE','DD','DEL','DETAILS','DIV','DL','DT','EM','H1','H2',
  'H3','H4','H5','H6','HR','I','IMG','INPUT','KBD','LI','OL','P','PRE','S','SPAN','STRONG',
  'SUB','SUMMARY','SUP','TABLE','TBODY','TD','TH','THEAD','TR','UL',
]);

const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'align', 'colspan', 'rowspan']);

function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }

      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();

        // Alle Event-Handler und nicht freigegebenen Attribute entfernen.
        if (!ALLOWED_ATTRS.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }

        // Nur unbedenkliche Protokolle zulassen: javascript: und data: in
        // href oder src wären eine direkte Skriptausführung.
        if (name === 'href' || name === 'src') {
          const value = attr.value.trim().toLowerCase();
          if (
            value.startsWith('javascript:') ||
            value.startsWith('vbscript:') ||
            (value.startsWith('data:') && !value.startsWith('data:image/'))
          ) {
            child.removeAttribute(attr.name);
          }
        }
      }

      if (child.tagName === 'A') {
        child.setAttribute('rel', 'noreferrer noopener nofollow');
        child.setAttribute('target', '_blank');
      }
      if (child.tagName === 'INPUT') {
        // Aufgabenlisten aus Markdown bleiben erhalten, aber nicht bedienbar.
        child.setAttribute('disabled', 'true');
      }

      walk(child);
    }
  };

  walk(template.content as unknown as Element);
  return template.innerHTML;
}


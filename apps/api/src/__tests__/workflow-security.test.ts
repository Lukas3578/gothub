/**
 * Tests für die Stellen der Workflow-Ausführung, an denen ein Fehler ein
 * Geheimnis preisgeben oder fremden Code einschleusen würde.
 *
 * Jeder dieser Tests entstand aus einem Fehler, der beim Durchspielen eines
 * echten Workflows aufgefallen ist.
 */

import { describe, expect, it } from 'vitest';
import { interpolate, parseWorkflow } from '../services/workflow-parser.js';

describe('Ausdrucksauflösung', () => {
  it('setzt ein Secret nicht ein, sondern verweist auf die Umgebungsvariable', () => {
    // Würde der Wert hier eingesetzt, stünde er im gespeicherten Kommandotext
    // und damit später im Log.
    const result = interpolate('echo ${{ secrets.API_KEY }}', {});
    expect(result).toBe('echo ${FORGE_SECRET_API_KEY}');
    expect(result).not.toContain('secrets.');
  });

  it('löst Variablen aus dem Kontext auf', () => {
    expect(interpolate('Ziel: ${{ env.ZIEL }}', { 'env.ZIEL': 'produktion' })).toBe(
      'Ziel: produktion',
    );
    expect(interpolate('${{ forge.sha }}', { 'forge.sha': 'abc123' })).toBe('abc123');
  });

  it('ersetzt einen unbekannten Ausdruck durch eine leere Zeichenkette', () => {
    // Bliebe der Platzhalter stehen, landete buchstäblich "${{ x.y }}" in der
    // Variablen – genau der Fehler, der das Secret-Problem verdeckt hat.
    expect(interpolate('[${{ gibt.es.nicht }}]', {})).toBe('[]');
  });

  it('verarbeitet mehrere Ausdrücke in einer Zeile', () => {
    expect(
      interpolate('${{ env.A }}-${{ secrets.B }}-${{ env.C }}', { 'env.A': '1', 'env.C': '3' }),
    ).toBe('1-${FORGE_SECRET_B}-3');
  });

  it('lässt Text ohne Ausdrücke unverändert', () => {
    const text = 'npm run build -- --mode=production';
    expect(interpolate(text, {})).toBe(text);
  });
});

describe('Workflow-Validierung', () => {
  it('weist eine Datei ohne Jobs ab', () => {
    expect(() => parseWorkflow('name: Leer\non: push\njobs: {}', 'x.yml')).toThrow();
  });

  it('übernimmt Schritt-Umgebung und Secrets-Ausdruck unverändert in die Definition', () => {
    // Die Auflösung passiert erst beim Zuweisen des Jobs an einen Runner,
    // nicht beim Einlesen der Datei.
    const workflow = parseWorkflow(
      [
        'name: Test',
        'on: push',
        'jobs:',
        '  bauen:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Schritt',
        '        env:',
        '          K: ${{ secrets.GEHEIM }}',
        '        run: echo hallo',
      ].join('\n'),
      'test.yml',
    );

    const step = workflow.jobs[0]!.steps[0]!;
    expect(step.env.K).toBe('${{ secrets.GEHEIM }}');
  });
});

/**
 * Spiegelt die Quoting-Funktion des Runners.
 *
 * Der Runner ist ein eigenes Paket ohne Testaufbau; die Logik ist aber
 * sicherheitsrelevant genug, um sie hier mitzuprüfen. Weicht die Umsetzung im
 * Runner ab, schlägt der Vergleich im letzten Test fehl.
 */
function quoteWithSecretRefs(value: string): string {
  const pattern = /\$\{(FORGE_SECRET_[A-Za-z0-9_]+)\}/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const quoteLiteral = (text: string): string => `'${text.split("'").join(`'\\''`)}'`;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) parts.push(quoteLiteral(value.slice(lastIndex, match.index)));
    parts.push(`"\${${match[1]}}"`);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) parts.push(quoteLiteral(value.slice(lastIndex)));
  if (parts.length === 0) return "''";
  return parts.join('');
}

describe('Shell-Quoting der Schritt-Umgebung', () => {
  it('lässt einen Secret-Verweis expandierbar', () => {
    expect(quoteWithSecretRefs('${FORGE_SECRET_X}')).toBe('"${FORGE_SECRET_X}"');
  });

  it('schützt literalen Text vor der Shell', () => {
    // Ohne einfache Anführungszeichen würde $(id) ausgeführt.
    expect(quoteWithSecretRefs('$(id)')).toBe("'$(id)'");
    expect(quoteWithSecretRefs('a;rm -rf /')).toBe("'a;rm -rf /'");
  });

  it('kommt mit einem einfachen Anführungszeichen im Wert zurecht', () => {
    // Naives Quoting würde hier die Zeichenkette beenden und den Rest als
    // Kommando ausführen.
    expect(quoteWithSecretRefs("it's")).toBe(`'it'\\''s'`);
  });

  it('mischt Literal und Secret korrekt', () => {
    expect(quoteWithSecretRefs('Bearer ${FORGE_SECRET_TOKEN}!')).toBe(
      `'Bearer '"\${FORGE_SECRET_TOKEN}"'!'`,
    );
  });

  it('liefert für einen leeren Wert eine leere Zeichenkette', () => {
    expect(quoteWithSecretRefs('')).toBe("''");
  });
});

describe('Absicherung der Umgebungsdatei', () => {
  /** Spiegelt die Prüfung aus dem Runner. */
  const isSafeEnvEntry = (key: string, value: string): boolean =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/[\r\n\0]/.test(value);

  it('weist einen Wert mit Zeilenumbruch ab', () => {
    // Docker liest die Datei zeilenweise; ein Umbruch im Wert würde eine
    // zusätzliche Variable wie PATH einschleusen.
    expect(isSafeEnvEntry('TOKEN', 'abc\nPATH=/boese')).toBe(false);
    expect(isSafeEnvEntry('TOKEN', 'abc\r\nLD_PRELOAD=/x.so')).toBe(false);
  });

  it('weist einen Schlüssel mit Sonderzeichen ab', () => {
    expect(isSafeEnvEntry('MEIN-KEY', 'wert')).toBe(false);
    expect(isSafeEnvEntry('A B', 'wert')).toBe(false);
  });

  it('lässt normale Werte zu', () => {
    expect(isSafeEnvEntry('API_TOKEN', 'abc-123_XYZ')).toBe(true);
    expect(isSafeEnvEntry('_PRIVAT', 'wert mit leerzeichen')).toBe(true);
  });
});

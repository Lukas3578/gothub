/**
 * Spracherkennung anhand von Dateiendungen und bekannten Dateinamen.
 *
 * Bewusst eine Tabelle statt einer Heuristik über den Dateiinhalt: das Ergebnis
 * ist vorhersagbar, schnell und reicht für Sprachstatistik und
 * Syntaxhervorhebung aus.
 */

const BY_FILENAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  'cmakelists.txt': 'CMake',
  'cargo.toml': 'TOML',
  'go.mod': 'Go Module',
  'package.json': 'JSON',
  '.gitignore': 'Ignore List',
  '.gitattributes': 'Git Attributes',
  '.editorconfig': 'EditorConfig',
  'justfile': 'Just',
};

const BY_EXTENSION: Record<string, string> = {
  // Web
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML',
  css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', styl: 'Stylus',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',

  // Systemnah
  c: 'C', h: 'C', i: 'C',
  cpp: 'C++', cxx: 'C++', cc: 'C++', hpp: 'C++', hxx: 'C++', hh: 'C++',
  rs: 'Rust', go: 'Go', zig: 'Zig', nim: 'Nim', d: 'D',
  asm: 'Assembly', s: 'Assembly',

  // JVM und .NET
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
  clj: 'Clojure', cljs: 'ClojureScript',
  cs: 'C#', fs: 'F#', vb: 'Visual Basic',

  // Skriptsprachen
  py: 'Python', pyi: 'Python', pyw: 'Python',
  rb: 'Ruby', erb: 'ERB',
  php: 'PHP', pl: 'Perl', pm: 'Perl',
  lua: 'Lua', tcl: 'Tcl', r: 'R',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Fish',
  ps1: 'PowerShell', psm1: 'PowerShell',
  bat: 'Batch', cmd: 'Batch',

  // Funktional
  hs: 'Haskell', lhs: 'Haskell',
  ml: 'OCaml', mli: 'OCaml',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hrl: 'Erlang',
  elm: 'Elm', purs: 'PureScript', lisp: 'Lisp', scm: 'Scheme',

  // Mobil
  swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++', dart: 'Dart',

  // Daten und Konfiguration
  json: 'JSON', jsonc: 'JSON', json5: 'JSON5',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'INI',
  xml: 'XML', xsd: 'XML', xsl: 'XML', svg: 'SVG',
  proto: 'Protocol Buffer', graphql: 'GraphQL', gql: 'GraphQL',
  sql: 'SQL', psql: 'SQL', prisma: 'Prisma',
  csv: 'CSV', tsv: 'TSV',

  // Dokumentation
  md: 'Markdown', markdown: 'Markdown', mdx: 'MDX',
  rst: 'reStructuredText', adoc: 'AsciiDoc', tex: 'TeX', org: 'Org',
  txt: 'Text',

  // Infrastruktur
  tf: 'HCL', tfvars: 'HCL', hcl: 'HCL',
  nix: 'Nix', dhall: 'Dhall',

  // Sonstiges
  sol: 'Solidity', v: 'Verilog', vhdl: 'VHDL', jl: 'Julia',
  f90: 'Fortran', f: 'Fortran', cob: 'COBOL', pas: 'Pascal',
};

/**
 * Dateien, die zwar Code enthalten, aber nicht in die Sprachstatistik des
 * Repositories einfließen sollen – sonst dominiert eingebundener
 * Fremdcode die Auswertung.
 */
const EXCLUDED_FROM_STATS = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)target\//,
  /(^|\/)\.git\//,
  /(^|\/)third_party\//,
  /\.min\.(js|css)$/,
  /\.lock$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|go\.sum)$/,
];

/** Sprachen, die nicht als Hauptsprache eines Repositories taugen. */
const NOT_A_PRIMARY_LANGUAGE = new Set([
  'JSON', 'JSON5', 'YAML', 'TOML', 'INI', 'XML', 'CSV', 'TSV', 'Text',
  'Markdown', 'MDX', 'reStructuredText', 'AsciiDoc', 'Org',
  'Ignore List', 'Git Attributes', 'EditorConfig', 'SVG',
]);

export function detectLanguage(path: string): string | null {
  const filename = path.split('/').pop()?.toLowerCase() ?? '';

  const byName = BY_FILENAME[filename];
  if (byName) return byName;

  // Dockerfile.dev, Dockerfile.prod usw.
  if (filename.startsWith('dockerfile')) return 'Dockerfile';

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return null;

  const extension = filename.slice(dotIndex + 1);
  return BY_EXTENSION[extension] ?? null;
}

export function isExcludedFromStats(path: string): boolean {
  return EXCLUDED_FROM_STATS.some((pattern) => pattern.test(path));
}

export function canBePrimaryLanguage(language: string): boolean {
  return !NOT_A_PRIMARY_LANGUAGE.has(language);
}

/**
 * Bestimmt die Hauptsprache aus einer Byte-Verteilung.
 * Konfigurations- und Dokumentationsformate werden nur herangezogen, wenn
 * sonst nichts übrig bleibt.
 */
export function primaryLanguageFrom(distribution: Record<string, number>): string | null {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return null;

  const real = entries.filter(([language]) => canBePrimaryLanguage(language));
  const pool = real.length > 0 ? real : entries;

  pool.sort((a, b) => b[1] - a[1]);
  return pool[0]?.[0] ?? null;
}

/**
 * ============================================================================
 * languageDetect.ts — File Extension → Language Mapper for CodeBridge
 * ============================================================================
 * 
 * Maps file extensions to their corresponding syntax-highlighting language
 * identifiers. Used when generating markdown code fences in the bridge format.
 * 
 * This mapping covers 80+ file extensions across all major programming
 * languages, markup languages, config formats, and data serialization formats.
 * 
 * Falls back to "text" for unrecognized extensions — this ensures the
 * LLM still receives the content without syntax hinting.
 * ============================================================================
 */

/** Map of file extension (lowercase, no dot) → language identifier */
const EXTENSION_MAP: Record<string, string> = {
  // ── Web Frontend ──────────────────────────────────────────────────────────
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",

  // ── Python ────────────────────────────────────────────────────────────────
  py: "python",
  pyw: "python",
  pyi: "python",
  ipynb: "json", // Jupyter notebooks are JSON

  // ── JVM Languages ─────────────────────────────────────────────────────────
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  gradle: "groovy",

  // ── C-Family ──────────────────────────────────────────────────────────────
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  m: "objectivec",
  mm: "objectivec",
  rs: "rust",
  go: "go",
  swift: "swift",

  // ── Functional / Misc Languages ───────────────────────────────────────────
  rb: "ruby",
  rbs: "ruby",
  pl: "perl",
  pm: "perl",
  php: "php",
  lua: "lua",
  r: "r",
  R: "r",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  fs: "fsharp",
  fsx: "fsharp",
  clj: "clojure",
  cljs: "clojure",
  dart: "dart",
  zig: "zig",
  nim: "nim",
  sol: "solidity",
  move: "move",

  // ── Shell / Scripting ─────────────────────────────────────────────────────
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",

  // ── Data & Config ─────────────────────────────────────────────────────────
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  csv: "csv",
  tsv: "csv",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "bash",
  properties: "properties",

  // ── Markup & Documentation ────────────────────────────────────────────────
  md: "markdown",
  mdx: "markdown",
  rst: "rst",
  tex: "latex",
  adoc: "asciidoc",
  org: "text",
  txt: "text",
  rtf: "text",

  // ── Database ──────────────────────────────────────────────────────────────
  sql: "sql",
  mysql: "sql",
  psql: "sql",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",

  // ── DevOps / IaC ──────────────────────────────────────────────────────────
  dockerfile: "dockerfile",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  ansible: "yaml",
  puppet: "ruby",

  // ── Build & Package ───────────────────────────────────────────────────────
  cmake: "cmake",
  makefile: "makefile",
  mk: "makefile",
  nix: "nix",
  lock: "json",

  // ── Web templating ────────────────────────────────────────────────────────
  ejs: "html",
  hbs: "html",
  handlebars: "html",
  mustache: "html",
  pug: "pug",
  jade: "pug",
  twig: "html",
  tmpl: "html",
};

/**
 * Detect the programming language from a file path.
 * 
 * @param filePath - Relative file path (e.g., "src/utils/helpers.ts")
 * @returns Language identifier string for code fence (e.g., "typescript")
 */
export function detectLanguage(filePath: string): string {
  // Normalize to forward slashes and get the filename
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts[parts.length - 1];

  // Check for dotfiles (e.g., ".gitignore", ".eslintrc")
  if (fileName.startsWith(".")) {
    const nameWithoutDot = fileName.slice(1).toLowerCase();
    if (EXTENSION_MAP[nameWithoutDot]) {
      return EXTENSION_MAP[nameWithoutDot];
    }
  }

  // Check for Dockerfile variants (e.g., "Dockerfile.prod", "Dockerfile.dev")
  if (fileName.toLowerCase().startsWith("dockerfile")) {
    return "dockerfile";
  }

  // Check for Makefile variants
  if (fileName.toLowerCase() === "makefile" || fileName.toLowerCase() === "gnumakefile") {
    return "makefile";
  }

  // Extract extension (last part after the final dot)
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex !== -1 && lastDotIndex < fileName.length - 1) {
    const ext = fileName.slice(lastDotIndex + 1).toLowerCase();
    if (EXTENSION_MAP[ext]) {
      return EXTENSION_MAP[ext];
    }
  }

  // Default fallback — safe for any LLM
  return "text";
}

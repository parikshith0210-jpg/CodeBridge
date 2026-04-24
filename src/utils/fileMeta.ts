/**
 * ============================================================================
 * fileMeta.ts — Binary Detection & Language Inference
 * ============================================================================
 * 
 * Two pure functions:
 *   - isProbablyBinary(path) → skip binaries from bridge text
 *   - languageFromPath(path) → annotate file blocks for the LLM
 * ============================================================================
 */

const binaryExtensions = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "bmp", "tiff",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "gz", "7z", "rar", "tar", "bz2", "xz",
  "mp3", "wav", "ogg", "flac", "mp4", "mov", "avi", "mkv",
  "exe", "dll", "so", "bin", "dmg", "msi",
  "ttf", "otf", "woff", "woff2", "eot",
  "pyc", "pyo", "pyd",
  "sqlite3", "db", "pkl", "npy", "h5",
  "class", "jar", "war",
]);

/**
 * Check if a file path looks like a binary file.
 * Used to exclude binaries from bridge text output.
 */
export function isProbablyBinary(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return binaryExtensions.has(ext);
}

/**
 * Infer a language identifier from the file extension.
 * Used to annotate <file> blocks in the bridge text.
 */
export function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    json: "json", css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", md: "md", mdx: "mdx",
    py: "py", pyw: "py", java: "java", kt: "kotlin",
    go: "go", rs: "rs", rb: "ruby", php: "php",
    cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c",
    yml: "yml", yaml: "yml", toml: "toml", xml: "xml",
    sh: "sh", bash: "sh", zsh: "sh", fish: "fish",
    sql: "sql", graphql: "graphql", gql: "graphql",
    dart: "dart", swift: "swift", lua: "lua",
    dockerfile: "dockerfile", makefile: "makefile",
    txt: "txt", env: "env",
  };
  return map[ext] || "text";
}

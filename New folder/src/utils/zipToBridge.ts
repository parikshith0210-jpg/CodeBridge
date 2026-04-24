/**
 * ============================================================================
 * zipToBridge.ts — ZIP → LLM Bridge Format Converter (Browser-Safe)
 * ============================================================================
 * 
 * Enhanced with logic from the Python bridge.py reference implementation.
 * 
 * ARCHITECTURE (mirrors Python zip_to_bridge):
 *   1. Load ZIP entirely in memory using JSZip — never write to disk
 *   2. Parse .gitignore if present (tries root/.gitignore AND .gitignore)
 *   3. Apply hard-coded ignore rules for common junk directories/files
 *   4. Classify each file: 'ok' | 'skipped' (size) | 'binary' (ext) | 'encoding' (non-utf8)
 *   5. Build ASCII directory tree with sorted entries
 *   6. Generate bridge format with status attributes on placeholders
 *   7. Return complete bridge string + detailed statistics
 * 
 * SECURITY MODEL:
 *   - All processing happens in memory — nothing touches disk
 *   - Binary files get placeholder tags, never decoded
 *   - .env files explicitly excluded (secret leakage prevention)
 *   - Files exceeding 250KB get safe placeholders
 *   - Path sanitization prevents traversal attacks
 * ============================================================================
 */

import JSZip from "jszip";
import { detectLanguage } from "./languageDetect";
import { parseGitignore, isIgnored } from "./gitignoreParser";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION CONSTANTS (mirrors bridge.py)
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum file size allowed (250KB) — files larger get placeholder */
const MAX_SIZE = 250_000;

/**
 * Binary file extensions that should ALWAYS be skipped with placeholder.
 * 
 * Mirrors the BINARY_EXTS set from bridge.py — images, documents,
 * compiled code, archives, media, fonts.
 */
const BINARY_EXTS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".tiff", ".tif",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
  // Python compiled
  ".pyc", ".pyo", ".pyd",
  // Executables & libraries
  ".exe", ".dll", ".so", ".dylib", ".bin", ".app", ".dmg", ".msi",
  // Archives
  ".zip", ".tar", ".gz", ".rar", ".7z", ".bz2", ".xz", ".zst",
  // Media
  ".mp3", ".mp4", ".avi", ".wav", ".flac", ".ogg", ".wma", ".wmv", ".mov", ".mkv",
  // Fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // Other binary
  ".sqlite3", ".db", ".pkl", ".pickle", ".npy", ".npz", ".h5", ".hdf5",
  ".parquet", ".arrow", ".class", ".jar", ".war",
]);

/**
 * Hard-coded list of directory names that are ALWAYS ignored.
 * These are dependency dirs, build artifacts, or VCS internals.
 * 
 * Mirrors the Python implementation's additional ignore list.
 */
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "__pycache__", ".next", "dist", "build",
  "venv", ".venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
  ".sass-cache", ".cache", "coverage", ".coverage", "target",
  ".turbo", ".nuxt", ".output", ".vercel", ".terraform",
  "vendor", ".gradle", ".idea", ".vscode", ".vs", "Pods",
  ".angular", ".svelte-kit", ".remix", "bower_components",
]);

/**
 * Exact filenames that are ALWAYS ignored (secrets, credentials, OS junk).
 * These match .env variants and OS-generated files.
 */
const IGNORED_FILENAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production",
  ".env.test", ".env.staging", ".env.preview",
  ".DS_Store", "Thumbs.db", "desktop.ini",
]);

/**
 * Additional file extensions to hard-ignore (logs, lock files, etc.)
 * These are separate from BINARY_EXTS because they're text-based but
 * should never be sent to an LLM.
 */
const IGNORED_EXTENSIONS = new Set([
  ".log",
]);

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** File status after processing — mirrors Python's status tracking */
type FileStatus = "ok" | "skipped" | "binary" | "encoding" | "ignored" | "gitignored";

/** Represents a file entry extracted from the ZIP */
interface ExtractedFile {
  /** Relative path from the ZIP root, using forward slashes */
  path: string;
  /** UTF-8 decoded file content (empty for non-ok statuses) */
  content: string;
  /** Detected language for syntax highlighting */
  language: string;
  /** Processing status */
  status: FileStatus;
  /** Original file size in bytes */
  size: number;
}

/** Tree node for ASCII tree generation */
interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Statistics about the conversion process */
export interface ConversionStats {
  /** Total files found in ZIP */
  totalFiles: number;
  /** Files successfully included */
  includedFiles: number;
  /** Files skipped due to size limit */
  skippedLarge: number;
  /** Files skipped because binary */
  binaryFiles: number;
  /** Files skipped due to encoding issues */
  skippedEncoding: number;
  /** Files ignored by hard-coded rules */
  ignoredFiles: number;
  /** Files ignored by .gitignore rules */
  gitignoredFiles: number;
  /** Total size of included files in bytes */
  totalSize: number;
  /** Final bridge format string length */
  outputLength: number;
  /** Name of the root directory */
  rootName: string;
}

/** Return type for the zipToBridge function */
export interface ZipToBridgeResult {
  /** The formatted bridge string */
  bridge: string;
  /** Conversion statistics */
  stats: ConversionStats;
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH SANITIZATION (mirrors bridge.py sanitize_path)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize a file path to prevent directory traversal attacks.
 * 
 * Mirrors Python: sanitize_path(path) with normpath + checks.
 * 
 * Steps:
 *   1. Normalize path (resolve . and ..)
 *   2. Strip leading slashes
 *   3. Check for ".." components after normalization
 *   4. Return clean relative path
 * 
 * @param path - Raw path string
 * @returns Sanitized relative path, or null if dangerous
 */
function sanitizePath(path: string): string | null {
  // Replace backslashes with forward slashes
  let normalized = path.replace(/\\/g, "/");

  // Remove any leading slashes or backslashes (absolute path attempt)
  normalized = normalized.replace(/^[/\\]+/, "");

  // Normalize: resolve . and .. components
  // Manual normpath since JS doesn't have os.path.normpath
  const parts = normalized.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === ".") {
      continue; // Skip current directory references
    } else if (part === "..") {
      // Check for traversal — if trying to go above root, reject
      if (resolved.length === 0) {
        return null; // Path escapes root
      }
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const cleanPath = resolved.join("/");
  if (!cleanPath) return null;

  // Final safety check: ensure no ".." in the result
  if (cleanPath.includes("..")) return null;

  return cleanPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine if a ZIP entry should be ignored based on hard-coded rules.
 * 
 * Checks in order:
 *   1. Exact filename match (secrets, OS junk)
 *   2. Binary extension match
 *   3. Ignored extension match (.log, etc.)
 *   4. Directory component match
 */
function isHardIgnored(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts[parts.length - 1];

  // Check exact filename
  if (IGNORED_FILENAMES.has(fileName)) return true;

  // Check extension
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot !== -1) {
    const ext = fileName.slice(lastDot).toLowerCase();
    if (IGNORED_EXTENSIONS.has(ext)) return true;
  }

  // Check directory components
  for (const part of parts.slice(0, -1)) {
    if (IGNORED_DIRECTORIES.has(part)) return true;
  }

  return false;
}

/**
 * Check if a file has a binary extension.
 * Returns the file status: 'binary' if binary extension, null otherwise.
 */
function checkBinaryExt(filePath: string): boolean {
  const fileName = filePath.split("/").pop() || "";
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot !== -1) {
    const ext = fileName.slice(lastDot).toLowerCase();
    return BINARY_EXTS.has(ext);
  }
  return false;
}

/**
 * Try to decode a Uint8Array as UTF-8 text.
 * Uses fatal: true to catch encoding errors (mirrors Python decode('utf-8')).
 * 
 * Additional heuristic: detect binary files that happen to be valid UTF-8
 * by checking for excessive control characters.
 */
function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    // Use TextDecoder with fatal: true — mirrors Python's strict decode
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(bytes);

    // Heuristic: check for excessive control characters (binary detection)
    let controlChars = 0;
    const sampleSize = Math.min(text.length, 8000);
    for (let i = 0; i < sampleSize; i++) {
      const code = text.charCodeAt(i);
      // Allow: tab(9), newline(10), carriage return(13), anything >= 32
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        controlChars++;
      }
    }
    // If more than 10% of sampled chars are control chars → binary
    if (sampleSize > 100 && controlChars / sampleSize > 0.1) {
      return null;
    }

    return text;
  } catch {
    // UTF-8 decode failed — mirrors Python's UnicodeDecodeError
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ASCII TREE BUILDING (mirrors bridge.py build_tree)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build an ASCII tree representation from a list of file paths.
 * 
 * Mirrors Python: build_tree(paths) with sorted entries and box-drawing chars.
 * 
 * Example output:
 *   project/
 *   ├── src/
 *   │   ├── main.py
 *   │   └── utils.py
 *   └── requirements.txt
 */
function buildTree(paths: string[], rootName: string): string {
  if (paths.length === 0) {
    return `${rootName}/\n└── (empty)`;
  }

  // Build a nested dictionary structure — mirrors Python's tree dict
  const root: TreeNode = { name: rootName, children: new Map(), isFile: false };

  for (const path of paths) {
    const parts = path.replace(/\\/g, "/").split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          children: new Map(),
          isFile: isLast,
        });
      }
      current = current.children.get(part)!;
    }
  }

  // Convert tree to ASCII — mirrors Python's render_tree()
  const lines: string[] = [`${rootName}/`];

  // Sort: directories first, then files; alphabetical within each group
  const entries = [...root.children.entries()].sort(([, a], [, b]) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  entries.forEach(([, node], index) => {
    const isLast = index === entries.length - 1;
    renderNode(node, "", isLast, lines);
  });

  return lines.join("\n");
}

/** Recursively render tree nodes — mirrors Python's recursive render_tree() */
function renderNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  lines: string[]
): void {
  const connector = isLast ? "└── " : "├── ";
  const suffix = node.isFile ? "" : "/";

  lines.push(`${prefix}${connector}${node.name}${suffix}`);

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  const childEntries = [...node.children.entries()].sort(([, a], [, b]) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  childEntries.forEach(([, child], index) => {
    const childIsLast = index === childEntries.length - 1;
    renderNode(child, childPrefix, childIsLast, lines);
  });
}

/**
 * Detect the root directory name from ZIP entries.
 * 
 * Many GitHub ZIPs have a single root like "project-main/".
 * Mirrors the Python logic of stripping common prefixes.
 */
function detectRoot(entries: string[]): {
  rootName: string;
  stripPrefix: string;
} {
  if (entries.length === 0) {
    return { rootName: "project", stripPrefix: "" };
  }

  const firstSlash = entries[0].indexOf("/");
  if (firstSlash === -1) {
    return { rootName: "project", stripPrefix: "" };
  }

  const potentialRoot = entries[0].slice(0, firstSlash + 1);
  const allShareRoot = entries.every((e) => e.startsWith(potentialRoot));

  if (allShareRoot) {
    return {
      rootName: potentialRoot.replace(/\/$/, ""),
      stripPrefix: potentialRoot,
    };
  }

  return { rootName: "project", stripPrefix: "" };
}

// ═══════════════════════════════════════════════════════════════════════════
// GITIGNORE LOADING (mirrors bridge.py load_gitignore)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Async: load and parse .gitignore from ZIP.
 * 
 * Mirrors Python: load_gitignore(zip_file) → Optional[pathspec.PathSpec]
 * Tries both ".gitignore" and "root/.gitignore" patterns.
 */
async function loadGitignoreAsync(
  zip: JSZip,
  stripPrefix: string
): Promise<ReturnType<typeof parseGitignore>> {
  const candidates = [
    ".gitignore",
    stripPrefix + ".gitignore",
  ];

  for (const gitignorePath of candidates) {
    const file = zip.file(gitignorePath);
    if (file) {
      try {
        const content = await file.async("text");
        if (content.trim()) {
          return parseGitignore(content);
        }
      } catch {
        continue;
      }
    }
  }

  return [];
}

/** Escape special XML characters in attribute values */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CONVERSION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a ZIP file into the CodeBridge LLM-friendly format.
 * 
 * Mirrors Python: zip_to_bridge(zip_path) with enhanced status tracking.
 * 
 * @param zipData - Raw ZIP file data (ArrayBuffer from browser File upload)
 * @param userPrompt - Instructions for the LLM
 * @returns Bridge format string + conversion statistics
 */
export async function zipToBridge(
  zipData: ArrayBuffer,
  userPrompt: string = "Improve code quality"
): Promise<ZipToBridgeResult> {
  // ── Step 1: Load ZIP into memory ──────────────────────────────────────────
  const zip = await JSZip.loadAsync(zipData);

  // ── Step 2: Collect all file entries ──────────────────────────────────────
  const allEntries: string[] = [];
  zip.forEach((relativePath, file) => {
    // Skip directory entries (end with /) — mirrors Python's path.endswith('/')
    if (!file.dir) {
      allEntries.push(relativePath);
    }
  });

  // Sort for deterministic output — mirrors Python's sorted()
  allEntries.sort();

  // ── Step 3: Detect and strip common root directory ────────────────────────
  const { rootName, stripPrefix } = detectRoot(allEntries);

  // ── Step 4: Load .gitignore rules ─────────────────────────────────────────
  // Mirrors Python: gitignore_spec = load_gitignore(zf)
  const gitignoreRules = await loadGitignoreAsync(zip, stripPrefix);

  // ── Step 5: Process each file ─────────────────────────────────────────────
  // Mirrors Python's file classification: ok, skipped, binary
  const extractedFiles: ExtractedFile[] = [];
  const stats: ConversionStats = {
    totalFiles: allEntries.length,
    includedFiles: 0,
    skippedLarge: 0,
    binaryFiles: 0,
    skippedEncoding: 0,
    ignoredFiles: 0,
    gitignoredFiles: 0,
    totalSize: 0,
    outputLength: 0,
    rootName,
  };

  for (const entryPath of allEntries) {
    // Strip common root prefix
    let cleanPath = stripPrefix
      ? entryPath.slice(stripPrefix.length)
      : entryPath;

    if (!cleanPath) continue;

    // ── Path sanitization ─────────────────────────────────────────────────
    // Mirrors Python: clean_path = sanitize_path(path)
    const sanitizedPath = sanitizePath(cleanPath);
    if (!sanitizedPath) {
      stats.ignoredFiles++;
      continue;
    }
    cleanPath = sanitizedPath;

    // ── Hard-coded ignore rules ───────────────────────────────────────────
    if (isHardIgnored(cleanPath)) {
      stats.ignoredFiles++;
      continue;
    }

    // ── .gitignore rules ──────────────────────────────────────────────────
    // Mirrors Python: gitignore_spec.match_file(path)
    if (gitignoreRules.length > 0 && isIgnored(cleanPath, false, gitignoreRules)) {
      stats.gitignoredFiles++;
      continue;
    }

    // ── Binary extension check ────────────────────────────────────────────
    // Mirrors Python: ext = os.path.splitext(path)[1].lower()
    if (checkBinaryExt(cleanPath)) {
      extractedFiles.push({
        path: cleanPath,
        content: "",
        language: "text",
        status: "binary",
        size: 0,
      });
      stats.binaryFiles++;
      continue;
    }

    // ── Read file bytes ───────────────────────────────────────────────────
    const file = zip.file(entryPath);
    if (!file) continue;

    const bytes = await file.async("uint8array");
    const fileSize = bytes.length;

    // ── Size limit check ──────────────────────────────────────────────────
    // Mirrors Python: info.file_size > MAX_SIZE
    if (fileSize > MAX_SIZE) {
      extractedFiles.push({
        path: cleanPath,
        content: "",
        language: "text",
        status: "skipped",
        size: fileSize,
      });
      stats.skippedLarge++;
      continue;
    }

    // ── UTF-8 decode ──────────────────────────────────────────────────────
    // Mirrors Python: content.decode('utf-8') with UnicodeDecodeError catch
    const decoded = tryDecodeUtf8(bytes);
    if (decoded === null) {
      extractedFiles.push({
        path: cleanPath,
        content: "",
        language: "text",
        status: "encoding",
        size: fileSize,
      });
      stats.skippedEncoding++;
      continue;
    }

    // ── File is OK — include in output ────────────────────────────────────
    const language = detectLanguage(cleanPath);

    extractedFiles.push({
      path: cleanPath,
      content: decoded,
      language,
      status: "ok",
      size: fileSize,
    });

    stats.includedFiles++;
    stats.totalSize += fileSize;
  }

  // Sort files_info to match — mirrors Python's sorted()
  extractedFiles.sort((a, b) => a.path.localeCompare(b.path));

  // ── Step 6: Build tree (only from files that passed all filters) ──────────
  const treePaths = extractedFiles.map((f) => f.path);
  const tree = buildTree(treePaths, rootName);

  // ── Step 7: Build the bridge format string ────────────────────────────────
  // Mirrors Python's line-by-line construction with header metadata
  const parts: string[] = [];

  // System instruction header
  parts.push(
    `You are an expert software engineer. Return ONLY full files wrapped in <file path="..."> tags. Never use diffs. Never omit code.\n`
  );

  // Opening project tag
  parts.push(`<project>`);

  // User instructions
  parts.push(`<instructions>\n${userPrompt}\n</instructions>\n`);

  // Directory tree
  parts.push(`<tree>\n${tree}\n</tree>\n`);

  // File contents — mirrors Python's per-file block generation
  for (const file of extractedFiles) {
    if (file.status === "ok") {
      // Normal file — include full content with code fence
      // Mirrors Python: <file path="..." lang="..." size="...">
      parts.push(
        `\n<file path="${escapeXml(file.path)}" lang="${file.language}" size="${file.size}">`
      );
      parts.push(`\n\`\`\`${file.language}\n${file.content}\n\`\`\``);
      parts.push(`\n</file>`);
    } else if (file.status === "skipped") {
      // Oversized file placeholder
      // Mirrors Python: [Skipped: Exceeds 250KB limit (was N bytes)]
      parts.push(
        `\n<file path="${escapeXml(file.path)}" status="skipped">`
      );
      parts.push(
        `\n[SKIPPED: Exceeds ${Math.round(MAX_SIZE / 1000)}KB limit (was ${formatFileSize(file.size)})]`
      );
      parts.push(`\n</file>`);
    } else if (file.status === "binary") {
      // Binary file placeholder
      // Mirrors Python: [Skipped: Binary file]
      parts.push(
        `\n<file path="${escapeXml(file.path)}" status="binary">`
      );
      parts.push(`\n[SKIPPED: Binary file]`);
      parts.push(`\n</file>`);
    } else if (file.status === "encoding") {
      // Non-UTF-8 encoding
      parts.push(
        `\n<file path="${escapeXml(file.path)}" status="encoding">`
      );
      parts.push(`\n[SKIPPED: Non-UTF8 encoding]`);
      parts.push(`\n</file>`);
    }
  }

  // Closing project tag
  parts.push(`\n</project>`);

  const bridge = parts.join("");
  stats.outputLength = bridge.length;

  return { bridge, stats };
}

/** Format file size for display in placeholders */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

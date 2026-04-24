/**
 * ============================================================================
 * bridgeToZip.ts — LLM Response → ZIP File Reconstructor (Browser-Safe)
 * ============================================================================
 * 
 * Enhanced with double-sanitization from the Python bridge.py reference.
 * 
 * SECURITY MODEL (Defense in Depth — mirrors Python's triple-pass sanitization):
 *   1. FIRST PASS: os.path.normpath equivalent — normalize . and .. components
 *   2. SECOND PASS: Check for ".." in normalized path → raise ValueError
 *   3. THIRD PASS: Final sanitize_path() validation
 *   4. Content cleaning — strip code fences while preserving internal formatting
 *   5. ZIP construction — build in memory, never write intermediate files
 * 
 * MIRRORS Python: bridge_to_zip(bridge_text, output_path)
 *   - Pattern: <file path="..." ...> ... </file> with re.DOTALL
 *   - Fence extraction: ```(?:\w+)?\n(.*?)```
 *   - Placeholder detection: status="skipped" or status="binary"
 * ============================================================================
 */

import JSZip from "jszip";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A single file extracted from the LLM response */
interface ExtractedFile {
  /** Sanitized relative path (forward slashes, no leading slash) */
  path: string;
  /** File content with code fences stripped */
  content: string;
  /** Whether this was a placeholder file */
  isPlaceholder: boolean;
}

/** Statistics about the reconstruction process */
export interface ReconstructionStats {
  /** Number of files successfully extracted */
  filesExtracted: number;
  /** Number of placeholder files */
  placeholderFiles: number;
  /** Number of files rejected due to path security issues */
  rejectedPaths: number;
  /** Details of rejected paths */
  rejectedDetails: Array<{ path: string; reason: string }>;
  /** Total bytes of all file contents */
  totalBytes: number;
  /** Final ZIP file size in bytes */
  zipSize: number;
}

/** Return type for bridgeToZip */
export interface BridgeToZipResult {
  /** The generated ZIP file as a Blob (ready for download) */
  blob: Blob;
  /** List of extracted files with paths and content */
  files: ExtractedFile[];
  /** Reconstruction statistics */
  stats: ReconstructionStats;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY: TRIPLE-PASS PATH SANITIZATION (mirrors bridge.py)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize a file path with triple-pass security validation.
 * 
 * Mirrors Python's bridge_to_zip path handling:
 *   Pass 1: os.path.normpath — normalize . and .. components
 *   Pass 2: Check normalized path for ".." → ValueError
 *   Pass 3: sanitize_path() for final validation
 * 
 * Additionally checks for:
 *   - Null bytes (path injection)
 *   - Absolute paths (/, \, C:\)
 *   - UNC paths (\\server)
 * 
 * @param rawPath - The path as extracted from the XML tag
 * @returns Object with sanitized path or error info
 */
function sanitizePath(rawPath: string): {
  path: string;
  error: string | null;
} {
  let path = rawPath.trim();

  // ── Null byte check (path injection attack) ────────────────────────────
  if (path.includes("\0")) {
    return { path: rawPath, error: "Contains null bytes (path injection)" };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FIRST PASS: Normalize (mirrors os.path.normpath)
  // ═══════════════════════════════════════════════════════════════════════
  
  // Replace backslashes with forward slashes
  path = path.replace(/\\/g, "/");
  
  // Normalize: resolve . and .. components manually
  const parts = path.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === ".") {
      continue;
    } else if (part === "..") {
      // If trying to go above root, that's a traversal attack
      if (resolved.length === 0) {
        return { path: rawPath, error: "Path traversal: escapes root" };
      }
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  let normalized = resolved.join("/");

  // ═══════════════════════════════════════════════════════════════════════
  // SECOND PASS: Check for ".." after normalization
  // Mirrors: if '..' in normalized.split(os.sep): raise ValueError
  // ═══════════════════════════════════════════════════════════════════════
  
  if (normalized.includes("..")) {
    return {
      path: rawPath,
      error: "Path traversal detected after normalization",
    };
  }

  // Check for absolute path attempts
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) {
    return { path: rawPath, error: "Absolute path not allowed" };
  }

  // Windows-style absolute paths (C:\, D:\, etc.)
  if (/^[a-zA-Z]:[/\\]/.test(rawPath)) {
    return { path: rawPath, error: "Windows absolute path not allowed" };
  }

  // UNC paths (\\server\share)
  if (rawPath.startsWith("\\\\")) {
    return { path: rawPath, error: "UNC path not allowed" };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THIRD PASS: Final validation (mirrors sanitize_path final checks)
  // ═══════════════════════════════════════════════════════════════════════
  
  // Empty path after normalization is invalid
  if (!normalized) {
    return { path: rawPath, error: "Empty path after normalization" };
  }

  return { path: normalized, error: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTENT CLEANING (mirrors bridge.py fence extraction)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clean the content extracted from between <file> tags.
 * 
 * Mirrors Python's fence extraction:
 *   fence_pattern = r'```(?:\w+)?\n(.*?)```' with re.DOTALL
 * 
 * Handles:
 *   1. Backtick fences: ```python\ncode\n```
 *   2. Tilde fences: ~~~python\ncode\n~~~
 *   3. Raw content with no fences
 *   4. Placeholder content ([SKIPPED: ...])
 * 
 * IMPORTANT: Only strips OPENING and CLOSING fence lines.
 * Internal formatting, whitespace, and newlines are preserved exactly.
 */
function cleanContent(rawContent: string): string {
  let content = rawContent;

  // Strip leading/trailing newlines from XML tag positioning
  content = content.replace(/^\n+/, "").replace(/\n+$/, "");

  // Try to match code fence pattern
  // Mirrors Python: fence_pattern = r'```(?:\w+)?\n(.*?)```'
  const fencePattern = /^(`{3,}|~{3,})[a-zA-Z0-9+-_]*\n?([\s\S]*?)\n?\1\s*$/;
  const match = content.match(fencePattern);

  if (match) {
    // Extract content between fences
    content = match[2];
    // Remove leading/trailing newline that was part of fence structure
    content = content.replace(/^\n/, "").replace(/\n$/, "");
  }

  return content;
}

/**
 * Check if a file block is a placeholder by examining its attributes.
 * 
 * Mirrors Python: checks for status="skipped" or status="binary"
 */
function isPlaceholder(attrsString: string): boolean {
  return (
    attrsString.includes('status="skipped"') ||
    attrsString.includes('status="binary"') ||
    attrsString.includes('status="encoding"')
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract all file blocks from an LLM response.
 * 
 * Mirrors Python: re.findall(pattern, bridge_text, re.DOTALL)
 * Pattern: <file\s+path="([^"]+)"[^>]*>(.*?)</file>
 */
function extractFiles(aiResponse: string): {
  files: ExtractedFile[];
  rejected: Array<{ path: string; reason: string }>;
} {
  const files: ExtractedFile[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  // Regex to match <file path="..." ...>...</file> blocks
  // The [\s\S] is equivalent to Python's re.DOTALL (s flag)
  const fileRegex = /<file\s+path="([^"]*)"([^>]*)>([\s\S]*?)<\/file>/g;

  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(aiResponse)) !== null) {
    const rawPath = match[1];
    const attrsString = match[2];
    const rawContent = match[3];

    // ── Triple-pass path sanitization ──────────────────────────────────
    const result = sanitizePath(rawPath);

    if (result.error) {
      rejected.push({
        path: rawPath,
        reason: result.error,
      });
      continue;
    }

    // ── Check if this is a placeholder file ────────────────────────────
    const placeholder = isPlaceholder(attrsString);

    if (placeholder) {
      // Placeholder files get empty content — mirrors Python's empty write
      files.push({
        path: result.path,
        content: "",
        isPlaceholder: true,
      });
    } else {
      // Clean content — strip code fences, preserve internal formatting
      const cleanedContent = cleanContent(rawContent);

      files.push({
        path: result.path,
        content: cleanedContent,
        isPlaceholder: false,
      });
    }
  }

  return { files, rejected };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CONVERSION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert an LLM response (in CodeBridge format) back to a ZIP file.
 * 
 * Mirrors Python: bridge_to_zip(bridge_text, output_path) → int
 * 
 * @param aiResponse - Raw text response from the LLM
 * @returns Object with ZIP blob, extracted files, and statistics
 */
export async function bridgeToZip(
  aiResponse: string
): Promise<BridgeToZipResult> {
  // ── Step 1: Extract file blocks ─────────────────────────────────────────
  const { files, rejected } = extractFiles(aiResponse);

  // ── Step 2: Build ZIP in memory ─────────────────────────────────────────
  // Mirrors Python: with zipfile.ZipFile(output_path, 'w', ZIP_DEFLATED) as zf
  const zip = new JSZip();
  let totalBytes = 0;
  let placeholderCount = 0;

  for (const file of files) {
    if (file.isPlaceholder) {
      // Write empty placeholder file — mirrors Python: files_dict[clean_path] = b''
      zip.file(file.path, "");
      placeholderCount++;
    } else {
      // Create ZipInfo with clean path — mirrors Python's ZipInfo + DEFLATED
      zip.file(file.path, file.content, {
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      totalBytes += new TextEncoder().encode(file.content).length;
    }
  }

  // ── Step 3: Generate ZIP blob ───────────────────────────────────────────
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    comment: "Generated by CodeBridge — https://codebridge.dev",
  });

  // ── Step 4: Build statistics ────────────────────────────────────────────
  const stats: ReconstructionStats = {
    filesExtracted: files.length,
    placeholderFiles: placeholderCount,
    rejectedPaths: rejected.length,
    rejectedDetails: rejected,
    totalBytes,
    zipSize: blob.size,
  };

  return { blob, files, stats };
}

/**
 * Trigger a browser download of a Blob with a given filename.
 * 
 * Creates a temporary URL, triggers download via invisible anchor,
 * then cleans up to prevent memory leaks.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();

  // Cleanup after short delay
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

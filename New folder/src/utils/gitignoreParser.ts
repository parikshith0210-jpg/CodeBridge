/**
 * ============================================================================
 * gitignoreParser.ts — Browser-Safe .gitignore Pattern Matcher for CodeBridge
 * ============================================================================
 * 
 * Mirrors the Python pathspec.PathSpec.from_lines('gitwildmatch', ...) behavior.
 * Implements the most common .gitignore patterns used in real repositories.
 * 
 * SECURITY: Intentionally conservative — if in doubt, EXCLUDE the file.
 * Better to skip a file than leak sensitive data to an LLM.
 * ============================================================================
 */

/** A single parsed gitignore rule */
interface GitIgnoreRule {
  /** The regex pattern to test against */
  regex: RegExp;
  /** Whether this is a negation rule (prefixed with !) */
  negate: boolean;
  /** Whether this rule only applies to directories */
  directoryOnly: boolean;
  /** The original pattern string (for debugging) */
  pattern: string;
}

/**
 * Parse a .gitignore file content into an array of matching rules.
 * 
 * Mirrors: pathspec.PathSpec.from_lines('gitwildmatch', content.splitlines())
 * 
 * Handles:
 *   - Exact file/folder names: "debug.log"
 *   - Wildcards: "*.log", "*.py[cod]"
 *   - Directory patterns: "build/", "__pycache__/"
 *   - Negation: "!important.log"
 *   - Path anchors: "/root-only.txt", "src/*.js"
 *   - Double-star globs (any depth matching)
 */
export function parseGitignore(content: string): GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];

  // Split lines — mirrors Python's content.splitlines()
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    // Strip trailing whitespace (Python .gitignore behavior)
    let line = rawLine.trimEnd();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Check for negation prefix
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);

    // Check for directory-only patterns (trailing slash)
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);

    // Skip empty patterns after stripping
    if (!line) continue;

    // Convert the gitignore glob pattern to a regex
    try {
      const regex = gitignorePatternToRegex(line);
      rules.push({ regex, negate, directoryOnly, pattern: line });
    } catch {
      // If regex compilation fails, skip this rule (safe default)
      console.warn(`[gitignore] Skipping invalid pattern: ${line}`);
    }
  }

  return rules;
}

/**
 * Check if a given file path is ignored by the rules.
 * 
 * Mirrors: gitignore_spec.match_file(path)
 * 
 * Rules are evaluated in order — LAST matching rule wins (git behavior).
 * 
 * @param filePath - Relative path from project root (forward slashes)
 * @param isDirectory - Whether the path represents a directory
 * @param rules - Parsed gitignore rules
 * @returns true if the file should be ignored
 */
export function isIgnored(
  filePath: string,
  isDirectory: boolean,
  rules: GitIgnoreRule[]
): boolean {
  // Normalize: forward slashes, no leading slash for matching
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "");

  let ignored = false;

  for (const rule of rules) {
    // Directory-only rules only match directories
    if (rule.directoryOnly && !isDirectory) continue;

    // Test the full path AND just the filename AND with trailing slash
    const filename = normalized.split("/").pop() || "";
    const matches =
      rule.regex.test(normalized) ||
      rule.regex.test(filename) ||
      rule.regex.test(normalized + "/");

    if (matches) {
      // Last matching rule wins — negation flips the result
      ignored = !rule.negate;
    }
  }

  return ignored;
}

/**
 * Convert a gitignore glob pattern to a JavaScript RegExp.
 * 
 * Handles:
 *   - "*" → match anything except "/"
 *   - "**" → match anything including "/"
 *   - "?" → any single character except "/"
 *   - "[abc]" → character classes
 *   - Anchored patterns (starting with "/") → match from root only
 *   - Unanchored patterns → match at any depth
 * 
 * Mirrors Python's gitwildmatch behavior.
 */
function gitignorePatternToRegex(pattern: string): RegExp {
  // Check if the pattern is anchored (starts with /)
  const anchored = pattern.startsWith("/");
  let p = anchored ? pattern.slice(1) : pattern;

  let regexStr = "";

  // Determine the prefix based on anchoring
  if (!anchored) {
    // Non-anchored patterns without a slash match at any depth
    if (!p.includes("/")) {
      regexStr += "(^|/)";
    } else {
      // Contains a slash → relative to root
      regexStr += "^";
    }
  } else {
    regexStr += "^";
  }

  let i = 0;
  while (i < p.length) {
    const ch = p[i];

    if (ch === "*") {
      if (p[i + 1] === "*") {
        // Double-star handling
        if (p[i + 2] === "/") {
          // "**/ " — match zero or more directories
          regexStr += "(.*/)?";
          i += 3;
        } else {
          // "**" at end — match everything including /
          regexStr += ".*";
          i += 2;
        }
      } else {
        // Single "*" — match anything except "/"
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (ch === "[") {
      // Find the closing bracket
      const endBracket = p.indexOf("]", i);
      if (endBracket !== -1) {
        regexStr += p.slice(i, endBracket + 1).replace(/\\/g, "\\\\");
        i = endBracket + 1;
      } else {
        regexStr += escapeRegex(ch);
        i += 1;
      }
    } else {
      regexStr += escapeRegex(ch);
      i += 1;
    }
  }

  // End anchor — match end of string or trailing slash
  regexStr += "(/|$)";

  return new RegExp(regexStr);
}

/** Escape special regex characters */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

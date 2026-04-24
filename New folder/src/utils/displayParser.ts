/**
 * ============================================================================
 * displayParser.ts — Parse LLM Manual Response for Display Only
 * ============================================================================
 * 
 * Parses the LLM's FILE: ... STATUS: ... output into structured blocks
 * for rendering in the UI. Does NOT mutate any project files.
 * 
 * Output format the LLM returns:
 *   FILE: src/main.ts STATUS: MODIFIED
 *   Line 15: -old code → +new code
 *   
 *   FILE: src/new-file.ts STATUS: CREATED
 *   <<<CONTENT>>>
 *   ...full file content...
 *   <<<END>>>
 *   
 *   FILE: src/unused.ts STATUS: UNCHANGED
 *   FILE: src/old.ts STATUS: DELETED
 * 
 * Parser design:
 *   - Uses explicit inContent flag (not content !== undefined)
 *   - Handles CRLF via split(/\r?\n/)
 *   - Pushes block only on next FILE: line or loop end
 *   - Validates STATUS against known values via regex
 * ============================================================================
 */

import type { ChangeStatus, ManualChangeBlock } from "../types";

/**
 * Parse a manual LLM response into structured change blocks.
 * 
 * @param response - Raw text from the LLM
 * @returns Array of ManualChangeBlock for UI rendering
 */
export function parseManualResponse(
  response: string
): ManualChangeBlock[] {
  const trimmed = response.trim();
  if (!trimmed) return [];

  // Handle CRLF (Windows line endings from model output)
  const lines = trimmed.split(/\r?\n/);
  const blocks: ManualChangeBlock[] = [];

  let currentBlock: ManualChangeBlock | null = null;
  let inContent = false;
  let contentLines: string[] = [];

  /** Push the current block to the blocks array and reset state */
  const pushBlock = () => {
    if (!currentBlock) return;

    // Attach accumulated content lines
    if (contentLines.length > 0) {
      currentBlock.content = contentLines.join("\n").replace(/\n+$/, "");
    }

    // Clean up empty detail lines
    currentBlock.details = currentBlock.details.filter(Boolean);
    blocks.push(currentBlock);

    // Reset state
    currentBlock = null;
    inContent = false;
    contentLines = [];
  };

  for (const line of lines) {
    // Match FILE: <path> STATUS: <STATUS>
    const fileMatch = line.match(
      /^FILE:\s+(.+?)\s+STATUS:\s+(MODIFIED|CREATED|DELETED|UNCHANGED)$/
    );

    if (fileMatch) {
      // New file block — push the previous one first
      pushBlock();

      currentBlock = {
        path: fileMatch[1].trim(),
        status: fileMatch[2] as ChangeStatus,
        details: [],
      };
      continue;
    }

    // If we haven't seen a FILE: line yet, skip
    if (!currentBlock) continue;

    // Content delimiters
    if (line.trim() === "<<<CONTENT>>>") {
      inContent = true;
      contentLines = [];
      continue;
    }

    if (line.trim() === "<<<END>>>") {
      inContent = false;
      continue;
    }

    // Accumulate content or detail lines
    if (inContent) {
      contentLines.push(line);
    } else if (line.trim()) {
      currentBlock.details.push(line);
    }
  }

  // Push the last block (important — don't lose it)
  pushBlock();

  return blocks;
}

/**
 * Check if a text looks like a manual FILE:/STATUS: response.
 * Used to validate before parsing.
 */
export function isProbablyManualResponse(text: string): boolean {
  return /^FILE:\s+.+\s+STATUS:\s+(MODIFIED|CREATED|DELETED|UNCHANGED)$/m.test(
    text
  );
}

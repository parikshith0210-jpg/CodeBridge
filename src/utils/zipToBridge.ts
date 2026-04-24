/**
 * ============================================================================
 * zipToBridge.ts — FileEntry[] → Bridge Text Serializer
 * ============================================================================
 * 
 * Converts extracted project files into the bridge text format:
 * 
 *   <meta project="name" />
 *   <file path="src/main.ts" lang="ts">
 *   <<<CODE_START>>>
 *   ...content...
 *   <<<CODE_END>>>
 *   </file>
 * 
 * Binary files are excluded from the output to save tokens.
 * Uses fixed sentinels (<<<CODE_START>>> / <<<CODE_END>>>)
 * since this is INPUT to the LLM, not round-trip output.
 * ============================================================================
 */

import type { FileEntry } from "../types";
import { languageFromPath } from "./fileMeta";

/**
 * Serialize project files into bridge text for LLM consumption.
 * 
 * @param projectName - Project name for the <meta> header
 * @param files - Array of extracted project files
 * @returns Formatted bridge text string
 */
export function filesToBridgeText(
  projectName: string,
  files: FileEntry[]
): string {
  const body = files
    .filter((f) => !f.isBinary)
    .map(
      (f) =>
        `<file path="${f.path}" lang="${languageFromPath(f.path)}">\n<<<CODE_START>>>\n${f.content}\n<<<CODE_END>>>\n</file>`
    )
    .join("\n\n");

  return `<meta project="${projectName}" />\n\n${body}\n`;
}

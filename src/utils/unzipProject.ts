/**
 * ============================================================================
 * unzipProject.ts — Browser-Side ZIP Extraction via JSZip
 * ============================================================================
 * 
 * Reads a ZIP file entirely in memory and returns FileEntry[].
 * Binary files are detected and marked isBinary=true with empty content.
 * Text files are decoded as UTF-8 strings.
 * 
 * JSZip is the standard library for browser-side ZIP processing.
 * ============================================================================
 */

import JSZip from "jszip";
import type { FileEntry } from "../types";
import { isProbablyBinary } from "./fileMeta";

/**
 * Extract all files from a ZIP archive.
 * 
 * @param file - The uploaded .zip File object
 * @returns projectName (from filename) and array of FileEntry objects
 */
export async function unzipProject(file: File): Promise<{
  projectName: string;
  files: FileEntry[];
}> {
  const zip = await JSZip.loadAsync(file);
  const files: FileEntry[] = [];

  // Sort entries for deterministic output
  const entries = Object.values(zip.files).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  for (const entry of entries) {
    // Skip directory entries
    if (entry.dir) continue;

    const path = entry.name;
    const binary = isProbablyBinary(path);

    if (binary) {
      files.push({ path, content: "", isBinary: true });
      continue;
    }

    // Decode as UTF-8 text
    const content = await entry.async("string");
    files.push({ path, content, isBinary: false });
  }

  // Derive project name from ZIP filename
  const projectName = file.name.replace(/\.zip$/i, "") || "project";

  return { projectName, files };
}

/**
 * ============================================================================
 * types.ts — Shared Types for Manual-First CodeBridge
 * ============================================================================
 * 
 * Clean, minimal type definitions for the entire app.
 * No patch types, no diff types — just file entries and change blocks.
 * ============================================================================
 */

/** A file extracted from the uploaded ZIP */
export type FileEntry = {
  path: string;
  content: string;
  isBinary?: boolean;
};

/** Change status as reported by the LLM */
export type ChangeStatus = "MODIFIED" | "CREATED" | "DELETED" | "UNCHANGED";

/** A single parsed block from the LLM's manual response */
export type ManualChangeBlock = {
  path: string;
  status: ChangeStatus;
  /** Line-by-line diff details for small changes */
  details: string[];
  /** Full content for large changes or new files */
  content?: string;
};

/**
 * ============================================================================
 * CodeBridge — Manual Vibecoding Tool
 * ============================================================================
 * 
 * Pipeline:
 *   1. Upload ZIP → extract text files → generate bridge text
 *   2. Copy/download bridge text + prompt for LLM
 *   3. Paste LLM response → parse FILE:/STATUS: blocks for display
 *   4. Review changes visually → apply manually in IDE
 * 
 * No patching, no automatic file mutation, no jsdiff.
 * The LLM's response is parsed ONLY for display and filtering.
 * ============================================================================
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { unzipProject } from "./utils/unzipProject";
import { filesToBridgeText } from "./utils/zipToBridge";
import { copyText } from "./utils/clipboard";
import { downloadTextFile } from "./utils/download";
import {
  parseManualResponse,
  isProbablyManualResponse,
} from "./utils/displayParser";
import { MANUAL_REVIEW_PROMPT } from "./prompt";
import type { FileEntry, ManualChangeBlock, ChangeStatus } from "./types";

// ─── Utility ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

const STATUS_STYLES: Record<ChangeStatus, { bg: string; text: string; dot: string }> = {
  MODIFIED: { bg: "bg-violet-500/10", text: "text-violet-400", dot: "bg-violet-400" },
  CREATED: { bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
  DELETED: { bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-400" },
  UNCHANGED: { bg: "bg-slate-500/10", text: "text-slate-500", dot: "bg-slate-500" },
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════

export default function App() {
  // ── Project State ──────────────────────────────────────────────────────
  const [originalFiles, setOriginalFiles] = useState<FileEntry[]>([]);
  const [projectName, setProjectName] = useState("");
  const [bridgeText, setBridgeText] = useState("");
  const [userInstructions, setUserInstructions] = useState("");

  // ── Response State ─────────────────────────────────────────────────────
  const [modelResponse, setModelResponse] = useState("");
  const [displayBlocks, setDisplayBlocks] = useState<ManualChangeBlock[]>([]);
  const [parseError, setParseError] = useState("");
  const [hideUnchanged, setHideUnchanged] = useState(true);

  // ── UI State ───────────────────────────────────────────────────────────
  const [toast, setToast] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasProject = originalFiles.length > 0;

  // Derived stats
  const stats = {
    total: originalFiles.length,
    text: originalFiles.filter((f) => !f.isBinary).length,
    binary: originalFiles.filter((f) => f.isBinary).length,
  };

  // Filtered blocks for display
  const visibleBlocks = hideUnchanged
    ? displayBlocks.filter((b) => b.status !== "UNCHANGED")
    : displayBlocks;

  // Block summary counts
  const blockCounts = {
    modified: displayBlocks.filter((b) => b.status === "MODIFIED").length,
    created: displayBlocks.filter((b) => b.status === "CREATED").length,
    deleted: displayBlocks.filter((b) => b.status === "DELETED").length,
    unchanged: displayBlocks.filter((b) => b.status === "UNCHANGED").length,
  };

  // ── Auto-reset toast ───────────────────────────────────────────────────
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 2500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // ── Auto-reset copied indicator ────────────────────────────────────────
  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(null), 2000);
      return () => clearTimeout(t);
    }
  }, [copied]);

  // ── Copy helper with toast ─────────────────────────────────────────────
  const doCopy = useCallback(
    async (text: string, label: string) => {
      try {
        await copyText(text);
        setCopied(label);
      } catch {
        setToast("Copy failed — try selecting text manually");
      }
    },
    []
  );

  // ── ZIP Upload Handler ─────────────────────────────────────────────────
  const handleUpload = useCallback(async (file: File) => {
    setIsExtracting(true);
    setParseError("");
    try {
      const result = await unzipProject(file);
      setProjectName(result.projectName);
      setOriginalFiles(result.files);
      setBridgeText(filesToBridgeText(result.projectName, result.files));
      setDisplayBlocks([]);
      setModelResponse("");
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to read ZIP file."
      );
    } finally {
      setIsExtracting(false);
    }
  }, []);

  // ── Process Response Handler ───────────────────────────────────────────
  const handleProcessResponse = useCallback(() => {
    try {
      setParseError("");

      if (!modelResponse.trim()) {
        throw new Error("Please paste the model response first.");
      }

      if (!isProbablyManualResponse(modelResponse)) {
        throw new Error(
          'Response does not match the expected format.\n\nExpected lines like:\nFILE: src/main.ts STATUS: MODIFIED\n\nMake sure the LLM follows the prompt instructions.'
        );
      }

      const blocks = parseManualResponse(modelResponse);
      if (blocks.length === 0) {
        throw new Error("No file blocks found in the response.");
      }

      setDisplayBlocks(blocks);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to process response."
      );
    }
  }, [modelResponse]);

  // ── Drag & Drop ────────────────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files;
      if (f[0]?.name.endsWith(".zip")) handleUpload(f[0]);
    },
    [handleUpload]
  );

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#0a0b10] text-white">
      {/* Background */}
      <div className="fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-950/40 via-[#0a0b10] to-indigo-950/30" />
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-violet-600/8 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-600/8 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-violet-600 flex items-center justify-center text-white font-bold text-sm">
              CB
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Code<span className="text-violet-400">Bridge</span>
              </h1>
              <p className="text-[11px] text-slate-500 -mt-0.5">
                Manual Vibecoding Tool
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/60 rounded-full border border-slate-700/40">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              100% Client-Side
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* ═══════════════════════════════════════════════════════════ */}
        {/* PANEL 1: UPLOAD ZIP                                         */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400 text-sm font-bold">
              1
            </div>
            <h2 className="text-lg font-semibold text-slate-200">
              Upload Project ZIP
            </h2>
            {hasProject && (
              <span className="text-xs text-emerald-400 ml-2">
                ✓ {projectName} — {stats.text} text, {stats.binary} binary
                skipped
              </span>
            )}
          </div>

          {!hasProject ? (
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`relative cursor-pointer rounded-xl border-2 border-dashed transition-all p-10 text-center ${
                dragging
                  ? "border-violet-400 bg-violet-500/10"
                  : "border-slate-700 bg-slate-900/50 hover:border-slate-600"
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
                className="hidden"
              />
              <svg
                className="w-10 h-10 mx-auto text-slate-500 mb-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="text-sm text-slate-300 font-medium">
                Drop your ZIP here or click to browse
              </p>
              <p className="text-xs text-slate-500 mt-1">
                GitHub archive downloads work perfectly
              </p>
            </div>
          ) : (
            <button
              onClick={() => {
                setOriginalFiles([]);
                setBridgeText("");
                setProjectName("");
                setDisplayBlocks([]);
                setModelResponse("");
                setParseError("");
              }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Upload a different ZIP
            </button>
          )}

          {isExtracting && (
            <p className="text-sm text-violet-400 mt-3 animate-pulse">
              Extracting files...
            </p>
          )}
        </section>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* PANEL 2: BRIDGE TEXT + PROMPT                               */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {hasProject && (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400 text-sm font-bold">
                2
              </div>
              <h2 className="text-lg font-semibold text-slate-200">
                Bridge Text
              </h2>
              <span className="text-xs text-slate-500">
                {fmtBytes(new TextEncoder().encode(bridgeText).length)}
              </span>
            </div>

            {/* User instructions */}
            <input
              type="text"
              value={userInstructions}
              onChange={(e) => setUserInstructions(e.target.value)}
              placeholder="Your change request (e.g., 'Add unit tests for all functions')"
              className="w-full mb-3 px-4 py-2.5 bg-slate-900/50 border border-slate-700/60 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all"
            />

            {/* Bridge text preview */}
            <pre className="w-full max-h-[250px] overflow-auto rounded-xl bg-slate-950 border border-slate-800 p-4 text-[12px] leading-relaxed text-slate-400 font-mono">
              {bridgeText}
            </pre>

            {/* Action buttons */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <button
                onClick={() => doCopy(bridgeText, "bridge")}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border transition-all ${
                  copied === "bridge"
                    ? "bg-emerald-600/20 border-emerald-500/30 text-emerald-400"
                    : "bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300"
                }`}
              >
                {copied === "bridge" ? "✓ Copied!" : "Copy Bridge"}
              </button>

              <button
                onClick={() =>
                  downloadTextFile(`${projectName}-bridge.txt`, bridgeText)
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg border border-slate-700/60 transition-all"
              >
                ⬇ Download bridge.txt
              </button>

              <button
                onClick={() =>
                  doCopy(
                    (userInstructions ? userInstructions + "\n\n" : "") +
                      MANUAL_REVIEW_PROMPT +
                      "\n\n" +
                      bridgeText,
                    "combo"
                  )
                }
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border transition-all ${
                  copied === "combo"
                    ? "bg-emerald-600/20 border-emerald-500/30 text-emerald-400"
                    : "bg-violet-600/30 hover:bg-violet-600/50 border-violet-500/30 text-violet-200"
                }`}
              >
                {copied === "combo"
                  ? "✓ Copied!"
                  : "Copy Prompt + Bridge"}
              </button>

              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg border border-slate-700/60 transition-all"
              >
                {showPrompt ? "Hide" : "Show"} Prompt
              </button>
            </div>

            {/* Collapsible prompt */}
            {showPrompt && (
              <div className="mt-3 p-4 bg-slate-900/40 border border-slate-800/60 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Manual Review Prompt
                  </p>
                  <button
                    onClick={() => doCopy(MANUAL_REVIEW_PROMPT, "prompt")}
                    className={`text-xs transition-colors ${
                      copied === "prompt"
                        ? "text-emerald-400"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {copied === "prompt" ? "✓ Copied!" : "Copy Prompt"}
                  </button>
                </div>
                <pre className="text-[11px] text-slate-500 font-mono whitespace-pre-wrap max-h-[200px] overflow-auto">
                  {MANUAL_REVIEW_PROMPT}
                </pre>
                <button
                  onClick={() =>
                    downloadTextFile(
                      `${projectName}-prompt.txt`,
                      MANUAL_REVIEW_PROMPT
                    )
                  }
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  ⬇ Download prompt.txt
                </button>
              </div>
            )}
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* PANEL 3: MODEL RESPONSE                                     */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {hasProject && (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400 text-sm font-bold">
                3
              </div>
              <h2 className="text-lg font-semibold text-slate-200">
                Paste LLM Response
              </h2>
            </div>

            <textarea
              value={modelResponse}
              onChange={(e) => {
                setModelResponse(e.target.value);
                setParseError("");
              }}
              placeholder={`Paste the LLM response here.\n\nExpected format:\nFILE: src/main.ts STATUS: MODIFIED\n  Line 15: -old code → +new code\n\nFILE: src/new-file.ts STATUS: CREATED\n<<<CONTENT>>>\n...full content...\n<<<END>>>`}
              className="w-full h-[200px] px-4 py-3 bg-slate-900/50 border border-slate-700/60 rounded-xl text-sm text-slate-200 placeholder-slate-600/50 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/40 transition-all font-mono"
            />

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleProcessResponse}
                disabled={!modelResponse.trim()}
                className={`inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold rounded-lg transition-all ${
                  !modelResponse.trim()
                    ? "bg-slate-800 text-slate-600 cursor-not-allowed"
                    : "bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/25 active:scale-[0.98]"
                }`}
              >
                Process Response
              </button>
            </div>

            {/* Parse error */}
            {parseError && (
              <div className="mt-3 p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                <p className="text-sm text-red-400 font-medium mb-1">
                  Parse Error
                </p>
                <pre className="text-sm text-red-300/70 whitespace-pre-wrap font-mono">
                  {parseError}
                </pre>
              </div>
            )}
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* PANEL 4: REVIEW CHANGES                                     */}
        {/* ═══════════════════════════════════════════════════════════ */}
        {displayBlocks.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-sm font-bold">
                  4
                </div>
                <h2 className="text-lg font-semibold text-slate-200">
                  Review Changes
                </h2>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideUnchanged}
                  onChange={(e) => setHideUnchanged(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-800 text-violet-600 focus:ring-violet-500"
                />
                Hide unchanged
              </label>
            </div>

            {/* Summary badges */}
            <div className="flex gap-2 mb-4 flex-wrap">
              {blockCounts.modified > 0 && (
                <span className="px-3 py-1 bg-violet-500/10 text-violet-400 rounded-full text-xs font-medium border border-violet-500/20">
                  {blockCounts.modified} modified
                </span>
              )}
              {blockCounts.created > 0 && (
                <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-medium border border-emerald-500/20">
                  {blockCounts.created} created
                </span>
              )}
              {blockCounts.deleted > 0 && (
                <span className="px-3 py-1 bg-red-500/10 text-red-400 rounded-full text-xs font-medium border border-red-500/20">
                  {blockCounts.deleted} deleted
                </span>
              )}
              {blockCounts.unchanged > 0 && !hideUnchanged && (
                <span className="px-3 py-1 bg-slate-500/10 text-slate-500 rounded-full text-xs font-medium border border-slate-500/20">
                  {blockCounts.unchanged} unchanged
                </span>
              )}
            </div>

            {/* Change cards */}
            <div className="space-y-3">
              {visibleBlocks.map((block) => {
                const style = STATUS_STYLES[block.status];
                return (
                  <article
                    key={`${block.path}-${block.status}`}
                    className={`rounded-xl border overflow-hidden transition-all ${
                      block.status === "DELETED"
                        ? "border-red-500/20 bg-red-500/[0.03]"
                        : block.status === "CREATED"
                          ? "border-emerald-500/20 bg-emerald-500/[0.03]"
                          : "border-slate-800 bg-slate-900/50"
                    }`}
                  >
                    {/* Card header */}
                    <div className="px-4 py-3 flex items-center gap-3 border-b border-slate-800/40">
                      <div
                        className={`w-2 h-2 rounded-full ${style.dot}`}
                      />
                      <span className="text-sm font-mono text-slate-300 font-medium truncate">
                        {block.path}
                      </span>
                      <span
                        className={`ml-auto shrink-0 px-2 py-0.5 text-[10px] font-bold uppercase rounded-full ${style.bg} ${style.text}`}
                      >
                        {block.status}
                      </span>
                      {block.content && (
                        <button
                          onClick={() =>
                            doCopy(block.content!, `content-${block.path}`)
                          }
                          className={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded bg-slate-800 hover:bg-slate-700 transition-colors ${
                            copied === `content-${block.path}`
                              ? "text-emerald-400"
                              : "text-slate-400"
                          }`}
                        >
                          {copied === `content-${block.path}`
                            ? "✓"
                            : "Copy"}
                        </button>
                      )}
                    </div>

                    {/* Details (line-by-line changes) */}
                    {block.details.length > 0 && (
                      <div className="px-4 py-2 border-b border-slate-800/20">
                        <pre className="text-[12px] text-slate-500 font-mono whitespace-pre-wrap">
                          {block.details.join("\n")}
                        </pre>
                      </div>
                    )}

                    {/* Full content (for large changes / new files) */}
                    {block.content && (
                      <div className="px-4 py-3">
                        <pre className="text-[12px] text-slate-400 font-mono whitespace-pre-wrap max-h-[300px] overflow-auto leading-relaxed">
                          {block.content}
                        </pre>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {visibleBlocks.length === 0 && hideUnchanged && (
              <p className="text-sm text-slate-500 text-center py-8">
                All files are unchanged. Toggle "Hide unchanged" to see them.
              </p>
            )}
          </section>
        )}

        {/* ── How it works (no project uploaded) ──────────────────────── */}
        {!hasProject && (
          <div className="mt-8 border-t border-slate-800/60 pt-8">
            <h2 className="text-lg font-semibold text-slate-200 mb-6 text-center">
              Manual Vibecoding Workflow
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  n: "1",
                  t: "Upload ZIP",
                  d: "Extract text files. Binaries are automatically excluded.",
                },
                {
                  n: "2",
                  t: "Copy to LLM",
                  d: "One click copies prompt + bridge text to clipboard.",
                },
                {
                  n: "3",
                  t: "Paste Response",
                  d: "LLM returns FILE:/STATUS: blocks. Paste and parse for review.",
                },
                {
                  n: "4",
                  t: "Apply Manually",
                  d: "Review changes card-by-card. Copy content. Edit in your IDE.",
                },
              ].map((s) => (
                <div
                  key={s.n}
                  className="p-5 bg-slate-900/40 rounded-xl border border-slate-800/60 text-center"
                >
                  <div className="w-10 h-10 mx-auto mb-3 rounded-lg bg-violet-600/10 flex items-center justify-center text-violet-400 text-lg font-bold">
                    {s.n}
                  </div>
                  <h3 className="font-semibold text-slate-200 text-sm mb-1">
                    {s.t}
                  </h3>
                  <p className="text-xs text-slate-500">{s.d}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 bg-slate-900/30 rounded-lg border border-slate-800/40">
                <p className="text-sm font-semibold text-slate-300 mb-1">
                  Display-Only Parsing
                </p>
                <p className="text-xs text-slate-500">
                  The LLM response is parsed for visual review only. No files
                  are automatically modified.
                </p>
              </div>
              <div className="p-4 bg-slate-900/30 rounded-lg border border-slate-800/40">
                <p className="text-sm font-semibold text-slate-300 mb-1">
                  Per-File Copy
                </p>
                <p className="text-xs text-slate-500">
                  Each changed file has a copy button. Grab the content and
                  paste it into your editor.
                </p>
              </div>
              <div className="p-4 bg-slate-900/30 rounded-lg border border-slate-800/40">
                <p className="text-sm font-semibold text-slate-300 mb-1">
                  Structured Response
                </p>
                <p className="text-xs text-slate-500">
                  LLM returns FILE:/STATUS: with optional content blocks.
                  Small changes show line diffs, large changes show full code.
                </p>
              </div>
            </div>
          </div>
        )}

        <footer className="mt-16 pt-8 border-t border-slate-800/40 text-center">
          <p className="text-xs text-slate-600">
            CodeBridge — Manual vibecoding tool for LLM-assisted code changes.
            All processing runs locally in your browser.
          </p>
        </footer>
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2 bg-slate-800 text-sm text-white rounded-lg border border-slate-700 shadow-xl z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

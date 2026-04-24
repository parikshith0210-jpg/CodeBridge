/**
 * ============================================================================
 * clipboard.ts — Clipboard Copy Helper
 * ============================================================================
 * 
 * Uses the modern Clipboard API (navigator.clipboard.writeText).
 * Falls back to execCommand('copy') for older browsers.
 * 
 * MDN: navigator.clipboard is available in secure contexts (HTTPS, localhost).
 * ============================================================================
 */

/**
 * Copy text to the system clipboard.
 * 
 * @throws Error if text is empty or clipboard is unavailable
 */
export async function copyText(text: string): Promise<void> {
  if (!text.trim()) {
    throw new Error("Nothing to copy.");
  }

  // Try modern Clipboard API first
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to legacy method
    }
  }

  // Legacy fallback: textarea + execCommand
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);

  if (!ok) {
    throw new Error("Clipboard copy failed. Please copy manually.");
  }
}

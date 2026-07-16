import type { QueuedItem } from "./runtime.js";

/**
 * Tag a queued item for delivery to the agent. A channel message is normally framed as coming
 * from the owner. The exception is a synthetic system signal (reply_user='ocr-signal', the deri6
 * OCR trigger) — it arrives source='channel' but is NOT from the owner, so it is framed as a system
 * signal instead. This keys on the SAME 'ocr-signal' sentinel the drift-detector + stop-guard use,
 * so all four agree on what is and isn't an owner message. Non-channel items pass through unwrapped.
 *
 * Lives in its own leaf module (type-only import of QueuedItem, no value edge back into runtime.ts)
 * so the three runtimes can import it without forming a circular dependency with runtime.ts, which
 * imports + registers those runtimes at module load.
 */
export function frameForDelivery(item: QueuedItem): string {
  if (item.source !== "channel") return item.prompt;
  if (item.reply_user === "ocr-signal") return `[System signal, not from the owner]\n\n${item.prompt}`;
  return `[Slack message from the owner]\n\n${item.prompt}`;
}

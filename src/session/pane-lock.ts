/**
 * Per-session pane-write lock.
 *
 * A tmux pane has exactly one input line, and only one writer may hold it at a time. Two independent
 * async paths write agent panes: the deliverer loop (deliverPrompt) and a live model/effort tune
 * (applyTune). Both gate on pane-idle then type keystrokes; with no shared lock they can pass the gate
 * in the same sub-second window and interleave keystrokes into one corrupted line or a mis-submitted
 * command. This serializes writes per session (FIFO), so a tune and a delivery for the SAME agent run
 * one-after-the-other instead of on top of each other.
 *
 * Scope is deliberately just the keystroke-writing critical section, not the (up to 120s) idle-wait —
 * holding the lock across that would stall unrelated deliveries. Different sessions never contend.
 */
const tails = new Map<string, Promise<unknown>>();

export function withPaneLock<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(session) ?? Promise.resolve();
  // Run fn once the previous holder settles, regardless of whether it resolved or rejected.
  const result = prev.then(fn, fn);
  // The stored tail must never reject, or the next waiter's `.then` onRejected would fire early and a
  // failed write would poison the lock. Callers still see the real outcome via the returned `result`.
  tails.set(
    session,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

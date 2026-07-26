/**
 * Claude Code effort levels — how hard the model thinks before answering.
 *
 * Verified live against `claude` 2.1.220: `/effort banana` replies
 * "Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto".
 * We deliberately offer only the five pinnable levels: `auto` defeats the point of pinning a value
 * per agent, and `ultracode` is a separate feature, not an effort tier.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Normalize a persisted/user-supplied effort value. Unknown or blank input resolves to undefined
 * ("no effort pinned"), never an error — agent.json is hand-editable, and a typo must not stop an
 * agent from launching. Mirrors how `runtime` is normalized in agents.ts.
 */
export function normalizeEffort(v: string | undefined): EffortLevel | undefined {
  const s = v?.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(s ?? "") ? (s as EffortLevel) : undefined;
}

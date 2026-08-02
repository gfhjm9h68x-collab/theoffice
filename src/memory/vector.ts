/**
 * Pure vector helpers for semantic memory search. No I/O, no model — so the fusion and the
 * distance maths stay exhaustively testable and the embedding backend can change underneath.
 *
 * Vectors are stored in the existing `memories.embedding` TEXT column as base64 of a Float32Array
 * (384 dims -> 1536 bytes -> ~2KB of base64). JSON would be ~3x larger for the same numbers and
 * would parse slower on every search; the column already exists, so no migration is needed.
 */

/** Encode a vector for storage. */
export function encodeVector(v: Float32Array | number[]): string {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

/** Decode a stored vector. Returns null for anything that is not a well-formed float32 blob. */
export function decodeVector(s: string | null | undefined): Float32Array | null {
  if (!s) return null;
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length === 0 || buf.length % 4 !== 0) return null;
    // Copy rather than view: Buffer memory is pooled, and a view into the pool would alias other data.
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for mismatched or empty vectors rather than throwing:
 * a malformed stored vector must degrade one candidate's score, never break the whole search.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion.
 *
 * Merges several ranked id lists into one, scoring each id as sum(1 / (k + rank)). Deliberately
 * rank-based, not score-based: keyword relevance (FTS) and cosine similarity are not on a common
 * scale, and normalising them against each other invents a comparison that does not exist. RRF only
 * needs the ORDER each retriever produced, which both of them genuinely have.
 *
 * An id that appears in both lists outranks one that is first in a single list — which is the point:
 * agreement between two different retrievers is the strongest signal we have.
 *
 * `k` damps the head of each list (the standard value is 60); a larger k flattens the advantage of
 * being first, a smaller k sharpens it.
 */
export function rrfFuse(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!;
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]) // ties break on id so the order is deterministic
    .map(([id]) => id);
}

import type { MemoryTier } from "../types.js";
import { embedText } from "./embed.js";
import { cosine, decodeVector, rrfFuse } from "./vector.js";
import { embeddingsFor, memoriesByIds, searchMemories, type MemoryRow } from "./store.js";

/**
 * Hybrid memory search: keyword (FTS5) and meaning (embeddings), fused with RRF.
 *
 * Why both, rather than replacing one with the other:
 *   - keywords win on names, numbers and identifiers — "JDV-94-T", "M-31", an IBAN. An embedding
 *     blurs exactly the tokens that make those findable.
 *   - embeddings win when the asker doesn't know the words used when the note was written — "that
 *     Dutch accountant thing" finding a note that says "Horvath Agnes, ZZP lezaras".
 * Neither is a superset of the other, so the fusion keeps whatever each is good at.
 *
 * Degradation is the load-bearing property: if embeddings are unavailable (library missing, model
 * not fetched, call too slow) this returns exactly what the keyword search returned. Semantic recall
 * is a bonus on top of a working system, never a dependency of it.
 */
export interface HybridArgs {
  agentId: string;
  q: string;
  category?: MemoryTier[];
  limit?: number;
  /** how many vector candidates to consider before fusion (kept above `limit` so RRF has room) */
  vectorPool?: number;
}

export async function hybridSearch(a: HybridArgs): Promise<MemoryRow[]> {
  const limit = a.limit ?? 20;
  // Both retrievers must offer a POOL, not a final answer. Fusing two lists of length `limit` makes
  // rank 1 of each tie, so with a small limit the keyword list — which matches on ANY term and so
  // always returns something — could shoulder out a strong semantic hit. Fetching a wider pool and
  // cutting after the fusion is what lets the ranks actually compete.
  const pool = Math.max(limit * 5, 25);
  const keyword = searchMemories({ agentId: a.agentId, q: a.q, category: a.category, limit: pool });
  if (!a.q.trim()) return keyword.slice(0, limit);

  const qv = await embedText(a.q, "query");
  if (!qv) return keyword.slice(0, limit); // no embeddings -> plain keyword search, unchanged

  const rows = embeddingsFor(a.agentId, a.category);
  if (rows.length === 0) return keyword.slice(0, limit);

  const scored: { id: number; score: number }[] = [];
  for (const r of rows) {
    const v = decodeVector(r.embedding);
    if (!v) continue;
    scored.push({ id: r.id, score: cosine(qv, v) });
  }
  scored.sort((x, y) => y.score - x.score);
  const vector = scored.slice(0, a.vectorPool ?? pool).map((s) => s.id);

  const fused = rrfFuse([keyword.map((r) => r.id), vector]).slice(0, limit);
  return memoriesByIds(fused);
}

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The load-bearing property of hybrid search is DEGRADATION: memory recall sits in the delivery path,
 * so when embeddings are unavailable — library missing, model not fetched, call too slow — search must
 * return exactly what the keyword index returned. Better results are optional; working search is not.
 *
 * The embedder and the store are mocked so these tests assert the CONTROL FLOW (which retrievers ran,
 * what was fused) rather than the quality of a particular model's vectors.
 */

const h = vi.hoisted(() => ({
  queryVector: null as Float32Array | null,
  keywordRows: [] as { id: number }[],
  embeddingRows: [] as { id: number; embedding: string }[],
  byIdsCalledWith: [] as number[],
  embedCalls: 0,
}));

vi.mock("./embed.js", () => ({
  embedText: async () => {
    h.embedCalls++;
    return h.queryVector;
  },
}));

vi.mock("./store.js", () => ({
  searchMemories: () => h.keywordRows,
  embeddingsFor: () => h.embeddingRows,
  memoriesByIds: (ids: number[]) => {
    h.byIdsCalledWith = ids;
    return ids.map((id) => ({ id }));
  },
}));

const { hybridSearch } = await import("./semantic.js");
const { encodeVector } = await import("./vector.js");

const vec = (...n: number[]) => Float32Array.from(n);

beforeEach(() => {
  h.queryVector = null;
  h.keywordRows = [];
  h.embeddingRows = [];
  h.byIdsCalledWith = [];
  h.embedCalls = 0;
});

describe("hybridSearch falls back to keywords", () => {
  it("returns the keyword rows unchanged when embeddings are unavailable", async () => {
    h.keywordRows = [{ id: 1 }, { id: 2 }];
    h.queryVector = null; // embedder says "not available"
    const out = await hybridSearch({ agentId: "a", q: "holland konyvelo" });
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
    expect(h.byIdsCalledWith).toEqual([]); // no fusion happened
  });

  it("returns the keyword rows when no memory has an embedding yet", async () => {
    h.keywordRows = [{ id: 3 }];
    h.queryVector = vec(1, 0);
    h.embeddingRows = []; // nothing backfilled
    const out = await hybridSearch({ agentId: "a", q: "auto" });
    expect(out).toEqual([{ id: 3 }]);
  });

  it("does not even embed an empty query", async () => {
    h.keywordRows = [{ id: 9 }];
    const out = await hybridSearch({ agentId: "a", q: "   " });
    expect(out).toEqual([{ id: 9 }]);
    expect(h.embedCalls).toBe(0);
  });
});

describe("hybridSearch fuses both retrievers", () => {
  it("surfaces a semantically close memory the keyword search missed", async () => {
    // The whole point: id 42 shares no word with the query, but its vector points the same way.
    h.keywordRows = [{ id: 7 }];
    h.queryVector = vec(1, 0);
    h.embeddingRows = [
      { id: 42, embedding: encodeVector(vec(0.99, 0.01)) }, // near
      { id: 43, embedding: encodeVector(vec(0, 1)) }, // orthogonal
    ];
    const out = await hybridSearch({ agentId: "a", q: "arrol a holland dologrol" });
    const ids = out.map((r) => r.id);
    expect(ids).toContain(42);
    expect(ids).toContain(7); // the keyword hit is never dropped
    expect(ids.indexOf(42)).toBeLessThan(ids.indexOf(43)); // nearer vector ranks higher
  });

  it("ranks a memory found by BOTH retrievers first", async () => {
    h.keywordRows = [{ id: 1 }, { id: 5 }];
    h.queryVector = vec(1, 0);
    h.embeddingRows = [
      { id: 9, embedding: encodeVector(vec(1, 0)) },
      { id: 5, embedding: encodeVector(vec(0.98, 0.02)) },
    ];
    const out = await hybridSearch({ agentId: "a", q: "baross berleti szerzodes" });
    expect(out[0]!.id).toBe(5); // in both lists -> wins over the top of either one
  });

  it("survives a corrupt stored vector instead of failing the search", async () => {
    h.keywordRows = [{ id: 1 }];
    h.queryVector = vec(1, 0);
    h.embeddingRows = [
      { id: 2, embedding: "!!!not-base64!!!" },
      { id: 3, embedding: encodeVector(vec(1, 0)) },
    ];
    const out = await hybridSearch({ agentId: "a", q: "barmi" });
    const ids = out.map((r) => r.id);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  it("respects the limit", async () => {
    h.keywordRows = [{ id: 1 }, { id: 2 }];
    h.queryVector = vec(1, 0);
    h.embeddingRows = [3, 4, 5, 6].map((id) => ({ id, embedding: encodeVector(vec(1, 0)) }));
    const out = await hybridSearch({ agentId: "a", q: "x", limit: 3 });
    expect(out.length).toBe(3);
  });
});

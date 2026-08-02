import { describe, it, expect } from "vitest";
import { cosine, decodeVector, encodeVector, rrfFuse } from "./vector.js";

describe("vector encoding", () => {
  it("round-trips a float32 vector", () => {
    const v = Float32Array.from([0.1, -0.25, 0.5, 0]);
    const back = decodeVector(encodeVector(v));
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(v));
  });

  it("returns null for junk instead of throwing", () => {
    // A corrupt column must cost one candidate, never the whole search.
    expect(decodeVector(null)).toBeNull();
    expect(decodeVector("")).toBeNull();
    expect(decodeVector(Buffer.from([1, 2, 3]).toString("base64"))).toBeNull(); // not a multiple of 4
  });

  it("does not alias the pooled Buffer it decoded from", () => {
    // Buffer.from(base64) draws from a shared pool; a Float32Array VIEW over it would change when the
    // pool is reused. Decoding must copy. Encode two vectors back-to-back and check the first survives.
    const a = decodeVector(encodeVector(Float32Array.from([1, 2, 3, 4])))!;
    for (let i = 0; i < 50; i++) decodeVector(encodeVector(Float32Array.from([9, 9, 9, 9])));
    expect(Array.from(a)).toEqual([1, 2, 3, 4]);
  });
});

describe("cosine", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1);
  });

  it("returns 0 rather than NaN for empty, zero or mismatched vectors", () => {
    expect(cosine(new Float32Array(0), new Float32Array(0))).toBe(0);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2]))).toBe(0);
  });
});

describe("rrfFuse", () => {
  it("ranks an id found by BOTH retrievers above one that is merely first in a single list", () => {
    // This is the whole reason for fusing: agreement between two different retrievers beats a strong
    // showing in one. `2` is second in both lists; `1` is first in one and absent from the other.
    const keyword = [1, 2, 3];
    const vector = [4, 2, 5];
    expect(rrfFuse([keyword, vector])[0]).toBe(2);
  });

  it("keeps ids that only one retriever found", () => {
    const fused = rrfFuse([[1], [2]]);
    expect(fused.sort()).toEqual([1, 2]);
  });

  it("is deterministic on ties", () => {
    // Same rank in symmetric lists -> identical scores; the order must still be stable across runs.
    expect(rrfFuse([[7, 8], [8, 7]])).toEqual(rrfFuse([[7, 8], [8, 7]]));
  });

  it("ignores empty lists", () => {
    expect(rrfFuse([[], [5, 6]])).toEqual([5, 6]);
    expect(rrfFuse([])).toEqual([]);
  });
});

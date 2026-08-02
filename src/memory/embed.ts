import { log } from "../logger.js";

/**
 * Text embedding for semantic memory search.
 *
 * Runs LOCALLY, in this process: the memory store holds the owner's private business, and shipping it
 * to a hosted embedding API to make search nicer would be a bad trade. The model (all-MiniLM-L6-v2,
 * 384 dims, ~90MB) is loaded lazily on first use and then kept; measured on the 2-core box: ~3s to
 * load, 18-70ms per memory-sized text.
 *
 * EVERY failure path returns null instead of throwing. Embeddings are an enhancement on top of the
 * FTS5 keyword index — if the library is absent, the model can't be fetched, or a call is slow, search
 * must silently fall back to keywords. Memory recall sits in the delivery path; it may get worse, it
 * may never break.
 */
const logger = log("memory");

/**
 * Model choice, decided by measurement on the real memory store, not by reputation:
 *
 *   all-MiniLM-L6-v2 (English-only)     — failed on Hungarian text outright.
 *   paraphrase-multilingual-MiniLM-L12  — spoke Hungarian but collapsed: unrelated memories all
 *                                         scored 0.42-0.45 against any query, because it is trained
 *                                         for SYMMETRIC similarity (sentence vs sentence).
 *   multilingual-e5-small               — chosen. Trained for ASYMMETRIC retrieval (short query vs
 *                                         long passage), which is exactly this job, and it ranked
 *                                         the right memory first for 3 of 4 probe questions where
 *                                         the previous model managed 1.
 *
 * E5 REQUIRES the "query:" / "passage:" prefixes — without them the model is measurably worse, and
 * mixing the two sides up silently degrades every search. Hence the explicit `kind` argument.
 *
 * Changing this constant invalidates every stored vector: clear memories.embedding and re-run
 * scripts/backfill-embeddings.mjs. Dimensions stay 384, so the storage format is unaffected.
 */
const MODEL = "Xenova/multilingual-e5-small";

/** Model input is capped at 128 word pieces; feeding more just wastes time on truncated text. */
const MAX_CHARS = 1200;
/** A single embed call may never hang the caller. */
const EMBED_TIMEOUT_MS = 10_000;

type Extractor = (text: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;

let extractorPromise: Promise<Extractor | null> | null = null;
let unavailableReason: string | null = null;

/** Load (once) the local feature-extraction pipeline. Returns null if it cannot be had. */
async function getExtractor(): Promise<Extractor | null> {
  if (unavailableReason) return null;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        // Dynamic + optional on purpose: the package is heavy (onnxruntime), and an install that does
        // not have it must keep working with keyword search alone.
        const mod = (await import("@huggingface/transformers")) as unknown as {
          pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Extractor>;
          env: Record<string, unknown>;
        };
        mod.env.cacheDir = process.env.OFFICE_MODEL_CACHE || `${process.env.HOME}/.cache/theoffice-models`;
        mod.env.allowRemoteModels = true;
        const t0 = Date.now();
        const ex = await mod.pipeline("feature-extraction", MODEL, { dtype: "fp32" });
        logger.info({ ms: Date.now() - t0 }, "embedding model loaded");
        return ex;
      } catch (err) {
        unavailableReason = err instanceof Error ? err.message : String(err);
        logger.warn({ err: unavailableReason }, "embeddings unavailable — semantic search falls back to keywords");
        return null;
      }
    })();
  }
  return extractorPromise;
}

/** True when embeddings can be produced. Used to decide whether a hybrid search is worth attempting. */
export async function embeddingsAvailable(): Promise<boolean> {
  return (await getExtractor()) != null;
}

/**
 * Embed one text. Returns a normalised 384-dim vector, or null when embeddings are unavailable or
 * the call exceeded EMBED_TIMEOUT_MS.
 */
export async function embedText(text: string, kind: "query" | "passage" = "passage"): Promise<Float32Array | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const ex = await getExtractor();
  if (!ex) return null;
  try {
    // The prefix is part of the model's contract, not decoration: a stored memory is a "passage",
    // the thing being asked is a "query". Getting these the wrong way round degrades every result.
    const input = `${kind}: ${trimmed.slice(0, MAX_CHARS)}`;
    const run = ex(input, { pooling: "mean", normalize: true });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), EMBED_TIMEOUT_MS));
    const out = await Promise.race([run, timeout]);
    if (!out) {
      logger.warn({ chars: trimmed.length }, "embedding timed out — falling back to keywords");
      return null;
    }
    return Float32Array.from(out.data as ArrayLike<number>);
  } catch (err) {
    logger.warn({ err }, "embedding failed — falling back to keywords");
    return null;
  }
}

/** Test seam: forget the loaded model (and any recorded failure) so a test can re-drive the load path. */
export function resetEmbedderForTests(): void {
  extractorPromise = null;
  unavailableReason = null;
}

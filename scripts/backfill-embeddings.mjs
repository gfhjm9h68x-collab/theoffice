#!/usr/bin/env node
/**
 * One-off (and re-runnable) backfill: embed every memory that has no vector yet.
 *
 * Idempotent by construction — it only ever selects rows WHERE embedding IS NULL, so running it
 * twice costs one query and does nothing. Safe to run while the engine is up: it writes one column
 * of already-existing rows and touches nothing the delivery path reads.
 *
 *   node scripts/backfill-embeddings.mjs [--limit N]
 */
import { join } from "node:path";
import { openDb } from "../dist/db/index.js";
import { memoriesMissingEmbedding, setEmbedding } from "../dist/memory/store.js";
import { embedText } from "../dist/memory/embed.js";
import { encodeVector } from "../dist/memory/vector.js";

// Same store the engine uses. OFFICE_TENANT_ROOT is how every other entry point locates the tenant.
const tenantRoot = process.env.OFFICE_TENANT_ROOT;
if (!tenantRoot) {
  console.error("OFFICE_TENANT_ROOT nincs beallitva — nem tudom, melyik adatbazist nyissam meg");
  process.exit(1);
}
openDb(join(tenantRoot, "store", "theoffice.db"));

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 1000;

const todo = memoriesMissingEmbedding(limit);
if (todo.length === 0) {
  console.log("nincs mit visszatolteni — minden memorianak van embeddingje");
  process.exit(0);
}
console.log(`${todo.length} memoria var embeddingre…`);

let ok = 0;
let failed = 0;
const t0 = Date.now();
for (const row of todo) {
  const v = await embedText(row.content);
  if (!v) {
    failed++;
    // The first failure is decisive: if the model cannot load, the rest will fail identically.
    if (failed === 1 && ok === 0) {
      console.error("az embedding nem elerheto — a keresés kulcsszavas marad. Megszakitva.");
      process.exit(1);
    }
    continue;
  }
  setEmbedding(row.id, encodeVector(v));
  ok++;
  if (ok % 25 === 0) console.log(`  ${ok}/${todo.length}…`);
}

console.log(`kesz: ${ok} embedding elmentve, ${failed} kihagyva, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

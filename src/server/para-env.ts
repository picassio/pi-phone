/**
 * Before pi-para and qmd-engine load: their SQLite goes through Node's own node:sqlite (`QMD_SQLITE_DRIVER=node`,
 * qmd-engine 2.7, pi-para 0.8), as better-sqlite3 has no Android build. Both read it once, when their modules load, so
 * `para.ts` imports this first. pi-phone runs no other driver: this sets it, whatever the environment said.
 *
 * Never a local model (AGENTS.md): `QMD_NO_LOCAL_MODELS=1` (qmd-engine 2.7.1) makes qmd refuse to select, load, download,
 * or fall back to node-llama-cpp; embeddings come from a remote API provider (Wiki settings) or not at all.
 *
 * On Android, qmd's vector search loads sqlite-vec's own Android build from the runtime (`native/android-arm64/vec0.so`,
 * `scripts/sqlite-vec.ts`): the sqlite-vec npm package has none. Elsewhere (CI, a computer) its npm package has one.
 */
import { fileURLToPath } from "node:url";

process.env.QMD_SQLITE_DRIVER = "node";
process.env.QMD_NO_LOCAL_MODELS = "1";

if (process.platform === "android") {
    process.env.QMD_SQLITE_VEC_PATH = fileURLToPath(new URL("../../native/android-arm64/vec0.so", import.meta.url));
}

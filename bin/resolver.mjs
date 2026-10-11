// Module hooks preloaded into every pi-phone process, including the coordinator, server, and session workers that
// pi spawns (bin/run.mjs puts this file in NODE_OPTIONS). The pi checkout is never modified; what pi-phone needs
// from it is done here, at load time:
//
// 1. `pi-src/<module>` resolves to `<PI_CHECKOUT>/packages/coding-agent/src/<module>`, so pi-phone imports the
//    checkout's source-only modules with static imports.
// 2. The session worker entry pi spawns (`experimental/session-worker.ts`) is redirected to `server/worker.ts`, which
//    runs pi's worker protocol with pi-phone's Harness. `process.argv[1]` is rewritten so pi's module does not take
//    itself for the entry.
// 3. pi-server's Unix listener publishes its socket with a hard link, which Android forbids in app data. The one
//    line is patched to `rename` (same atomic publish, same inode) when that module loads.
//
// Each patch asserts the exact text it expects, so a pi update that changes it fails at startup instead of silently
// doing something else.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = process.env.PI_CHECKOUT;
if (checkout === undefined) throw new Error("PI_CHECKOUT is not set; start through bin/run.mjs");
const source = resolve(checkout, "packages/coding-agent/src");
const prefix = "pi-src/";

const piWorkerEntry = resolve(source, "experimental/session-worker.ts");
const phoneWorkerEntry = resolve(fileURLToPath(new URL("..", import.meta.url)), "server/worker.ts");
const piWorkerEntryUrl = pathToFileURL(piWorkerEntry).href;
const phoneWorkerEntryUrl = pathToFileURL(phoneWorkerEntry).href;

const unixListener = pathToFileURL(resolve(checkout, "packages/server/src/transports/unix/listener.ts")).href;
const LINK_LINE = "await link(ownedBindPath, this.path);";
const RENAME_LINE = "await rename(ownedBindPath, this.path);";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(prefix)) {
			const path = resolve(source, specifier.slice(prefix.length));
			if (!existsSync(path)) throw new Error(`pi source module not found: ${path}`);
			return { url: pathToFileURL(path).href, shortCircuit: true };
		}
		const resolved = nextResolve(specifier, context);
		if (
			context.parentURL === undefined &&
			resolved.url === piWorkerEntryUrl &&
			process.env.__PI_INTERNAL_SPAWN === "session-worker"
		) {
			if (!existsSync(phoneWorkerEntry)) throw new Error(`pi-phone worker entry not found: ${phoneWorkerEntry}`);
			process.argv[1] = phoneWorkerEntry;
			return { ...resolved, url: phoneWorkerEntryUrl };
		}
		return resolved;
	},
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (url !== unixListener) return result;
		const text = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
		if (!text.includes(LINK_LINE)) {
			throw new Error(`pi-server unix listener changed; expected "${LINK_LINE}" in ${fileURLToPath(url)}`);
		}
		if (!text.includes("rename")) throw new Error(`pi-server unix listener no longer imports rename`);
		return { ...result, source: text.replace(LINK_LINE, RENAME_LINE) };
	},
});

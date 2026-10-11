// Resolve `pi-src/<module>` to `<PI_CHECKOUT>/packages/coding-agent/src/<module>`, so pi-phone code imports the
// checkout's source-only modules (experimental/, core/) with static imports.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.env.PI_CHECKOUT;
if (checkout === undefined) throw new Error("PI_CHECKOUT is not set; start through bin/run.mjs");
const source = resolve(checkout, "packages/coding-agent/src");
const prefix = "pi-src/";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith(prefix)) return nextResolve(specifier, context);
		const path = resolve(source, specifier.slice(prefix.length));
		if (!existsSync(path)) throw new Error(`pi source module not found: ${path}`);
		return { url: pathToFileURL(path).href, shortCircuit: true };
	},
});

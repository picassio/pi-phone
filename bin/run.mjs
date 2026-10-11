#!/usr/bin/env node
// Run a pi-phone TypeScript entry with the pi checkout's source resolver preloaded, so `@earendil-works/*`
// imports resolve to the checkout's `src` and the experimental modules load from source.
//
//   node bin/run.mjs <entry.ts> [args...]
//   node bin/run.mjs --test <files...>
//
// PI_CHECKOUT points at the pi monorepo; defaults to ~/projects/pi.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export const checkout = resolve(process.env.PI_CHECKOUT ?? resolve(homedir(), "projects", "pi"));
const resolver = resolve(checkout, "packages/coding-agent/src/experimental/source-resolver.ts");
if (!existsSync(resolver)) {
	console.error(`pi checkout not found at ${checkout} (set PI_CHECKOUT)`);
	process.exit(1);
}

const args = process.argv.slice(2);
// Preloaded through NODE_OPTIONS so the processes pi spawns (coordinator, server, session workers) get them too.
const preload = [resolver, resolve(here, "resolver.mjs")].map((path) => `--import ${pathToFileURL(path).href}`).join(" ");
const nodeArgs = [];
if (args[0] === "--test") {
	nodeArgs.push("--test", ...args.slice(1));
} else {
	nodeArgs.push(...args);
}
const child = spawn(process.execPath, nodeArgs, {
	stdio: "inherit",
	env: { ...process.env, PI_CHECKOUT: checkout, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ") },
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	process.exit(code ?? 1);
});

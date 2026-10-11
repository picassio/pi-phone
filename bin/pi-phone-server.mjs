#!/usr/bin/env node
// Start the pi-phone server: `node bin/pi-phone-server.mjs [--listen host:port] [--session-dir dir]`.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const child = spawn(
	process.execPath,
	[resolve(here, "run.mjs"), resolve(here, "../server/main.ts"), ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));

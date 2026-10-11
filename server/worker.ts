// Session worker entry. pi's SessionWorkerManager spawns its own worker module; bin/resolver.mjs redirects that
// entry here. Same control protocol as pi's worker; only the Harness composition is ours.
import { consumeInternalProcessRole } from "pi-src/experimental/process.ts";
import { runSessionWorkerWithHarness } from "pi-src/experimental/session-worker.ts";
import { createPhoneHarness } from "./harness.ts";
import { redirectConsoleToFile } from "./log.ts";
import { DATA_DIR_ENV } from "./settings.ts";

process.title = "pi-phone-worker";
const dataDir = process.env[DATA_DIR_ENV];
if (dataDir === undefined) throw new Error(`${DATA_DIR_ENV} is not set; workers must be spawned by server/main.ts`);
redirectConsoleToFile(dataDir, "worker");
console.log("worker starting");
const role = consumeInternalProcessRole();
if (role !== "session-worker") throw new Error("pi-phone worker requires an internal session-worker invocation");

runSessionWorkerWithHarness(process.argv.slice(2), createPhoneHarness).catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});

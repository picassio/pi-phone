// Session worker entry, spawned by pi's SessionWorkerManager through `workerEntryUrl`. Same control protocol as
// pi's worker; only the Harness composition is ours.
import { consumeInternalProcessRole } from "pi-src/experimental/process.ts";
import { runSessionWorkerWithHarness } from "pi-src/experimental/session-worker.ts";
import { createPhoneHarness } from "./harness.ts";

const role = consumeInternalProcessRole();
if (role !== "session-worker") throw new Error("pi-phone worker requires an internal session-worker invocation");

runSessionWorkerWithHarness(process.argv.slice(2), createPhoneHarness).catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});

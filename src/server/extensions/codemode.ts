/**
 * Codemode: Pi Durable's own (1.2.0 and later). The agent writes short JavaScript that calls its tools as nested calls
 * (`tools.<name>(args)`), batching, chaining, and filtering before output reaches the model. Scripts run in a QuickJS
 * sandbox without Node, files, network, or timers; every call they make goes through the same checks and hooks as a
 * direct call. A script survives a restart: it is replayed from a journal of the results it got. `store()` and `load()`
 * keep values per conversation. The `codemode` prompt section lists the tools scripts can call.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { PocketHost } from "../host.ts";

export const CODEMODE_TOOL = "codemode";

export default function createCodemode(_host: PocketHost) {
    // No models.* for scripts: a script that generates images or classifies text spends the owner's money unasked.
    return createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false });
}

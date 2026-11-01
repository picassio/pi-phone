/**
 * Formal checks (PP-316): pstack's statechart skill (`third_party/pstack-statechart/`), which checks a TLA+ model with
 * TLC and draws it as a Mermaid statechart. The built-in extension `extensions/formal.ts` owns it: while it is on, phone
 * and server sessions list the skill (`FORMAL_SKILLS`), and sessions on a machine with the TLC machine tool list the
 * copy the tool put there (`ToolSpec.skillsModule`). Off: neither.
 */
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The extension's module, and its name as it installs. */
export const FORMAL_MODULE = "formal.ts";
export const FORMAL_EXTENSION = "pocket-formal";

/** The skill folders the extension adds, while it is on. */
export const FORMAL_SKILLS = [join(APP_ROOT, "third_party", "pstack-statechart", "skills")];

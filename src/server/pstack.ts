/**
 * pstack commands (PP-550; the owner's decisions of 2026-11-21 after research PP-541, wiki
 * `resources/pstack-update-2026-11`): thirteen of pstack's skills (cursor/plugins `pstack/skills/`, MIT, Lauren Tan) in
 * `third_party/pstack/`, adapted to pi-phone's tools by `scripts/sync-pstack.ts` and its patch. Each is a slash command
 * only (`disable-model-invocation: true`): sessions list them as `/skill:<name>`, and the system prompt names none of
 * them, so the extension adds nothing to it.
 *
 * The built-in extension `extensions/pstack.ts` owns them, on by default (the owner's choice, PP-551): while it is on,
 * phone and server sessions list them (`PSTACK_SKILLS`); off, none do.
 */
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The extension's module, and its name as it installs. */
export const PSTACK_MODULE = "pstack.ts";
export const PSTACK_EXTENSION = "pocket-pstack";

/** The skill folders the extension adds, while it is on. */
export const PSTACK_SKILLS = [join(APP_ROOT, "third_party", "pstack", "skills")];

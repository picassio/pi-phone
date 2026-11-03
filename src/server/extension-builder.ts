/**
 * Extension builder (PP-367; the owner's decision of 2026-11-03 after research PP-365, wiki
 * `resources/deepseek-harness-creator-mode-research`): the `extension-builder` skill teaches Pi to make a drop-in
 * extension from a chat request (its files, the server API, the `pocket` browser API, the owner's UI rules, and the loop:
 * a small first version from one of its templates, checked, installed with `extension_install`, turned on by the owner,
 * looked at in the live app, fixed in place). Its ideas and some text are adapted from DeepSeek Harness's
 * `cordis-plugin-development` skill (MIT, `third_party/deepseek-harness/`).
 *
 * The built-in extension `extensions/extension-builder.ts` owns it, on by default: while it is on, phone and server
 * sessions list the skill (`BUILDER_SKILLS`); off, none do.
 */
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The extension's module, and its name as it installs. */
export const BUILDER_MODULE = "extension-builder.ts";
export const BUILDER_EXTENSION = "pocket-extension-builder";

/** The skill folders the extension adds, while it is on. */
export const BUILDER_SKILLS = [join(APP_ROOT, "src", "extension-builder", "skills")];

/** The skill itself, and its templates: each a drop-in that loads as it is. */
export const BUILDER_SKILL = join(BUILDER_SKILLS[0]!, "extension-builder");
export const BUILDER_TEMPLATES = join(BUILDER_SKILL, "templates");

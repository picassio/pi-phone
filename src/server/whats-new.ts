/**
 * What's new (PP-235): release notes in `whatsnew/<version>.md`, one file a release, each starting with a short header:
 *
 *   ---
 *   title: A welcome, and Getting started
 *   date: 2026-10-28
 *   big: true
 *   ---
 *   - **Welcome:** …
 *
 * A release marked `big` (owner's decision G) shows a card on the home screen and the session list until the person
 * dismisses it or asks Pi to show it (the Getting started session's What's new topic, which reads the file).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The app's release notes, one file a version. */
export const WHATS_NEW_DIR = join(APP_ROOT, "whatsnew");

export type WhatsNew = { version: string; title: string; date: string; big: boolean };

/** A release's version as its file is named: letters, digits, dots, dashes. */
const VERSION = /^[\w.-]{1,40}$/;

/** The header of one notes file: `title`, `date` (YYYY-MM-DD), `big`; an error names what is missing. */
export function parseWhatsNew(version: string, text: string): WhatsNew {
    const head = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"));

    if (head === null) {
        throw new Error(`whatsnew/${version}.md starts with a header between --- lines (title, date, big).`);
    }

    const fields = new Map(
        head[1]!
            .split("\n")
            .map((line) => /^(\w+):\s*(.*)$/.exec(line.trim()))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => [match[1]!, match[2]!.replace(/^"(.*)"$/, "$1").trim()]),
    );
    const title = fields.get("title") ?? "";
    const date = fields.get("date") ?? "";

    if (title === "" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`whatsnew/${version}.md needs a title and a date (YYYY-MM-DD) in its header.`);
    }

    return { version, title, date, big: fields.get("big") === "true" };
}

/** Every release's notes in `dir`, newest first (by date, then version). */
export function readWhatsNew(dir: string): WhatsNew[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith(".md") && VERSION.test(name.slice(0, -3)))
        .map((name) => parseWhatsNew(name.slice(0, -3), readFileSync(join(dir, name), "utf8")))
        .sort((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version));
}

/** The newest release marked big, if any. */
export const newestBig = (dir: string): WhatsNew | undefined => readWhatsNew(dir).find((each) => each.big);

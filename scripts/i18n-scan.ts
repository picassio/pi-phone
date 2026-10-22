/**
 * Finds the people-facing text in the web app's `html` templates (PP-81): whole text nodes, and the attributes that
 * label things (title, aria-label, placeholder, label, detail, hint, alt), with where each is. Used by i18n-check.ts
 * (what is not yet in `t()`), and by `--wrap <file>…`, which puts the plain ones in `t()`:
 *
 *   node scripts/i18n-scan.ts --wrap web/sessions.js
 *
 * Text a template builds around `${…}` (a sentence in pieces) is listed as `mixed`: it becomes one sentence with a
 * placeholder by hand, never word by word.
 */
import { readFileSync, writeFileSync } from "node:fs";

export type Found = {
    kind: "text" | "attr" | "mixed";
    /** The text as people read it: whitespace collapsed. */
    text: string;
    /** Where it is in the file's source, and how long. */
    start: number;
    end: number;
    line: number;
    /** For an attribute, its name. */
    attr?: string;
    /** Spaces kept outside `t()` (a text node's own leading and trailing spaces on the same line). */
    lead?: string;
    trail?: string;
};

const ATTRS = new Set(["title", "aria-label", "placeholder", "label", "detail", "hint", "alt"]);
/** Words, not keys or symbols: two letters in a row somewhere. */
const WORDY = /[A-Za-z]{2,}/;

/** Skip a JS string or template starting at `i` (its quote); answers the index after it. */
function skipString(src: string, i: number): number {
    const quote = src[i]!;

    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") {
            j++;
        } else if (quote === "`" && src[j] === "$" && src[j + 1] === "{") {
            j = skipExpression(src, j + 2) - 1;
        } else if (src[j] === quote) {
            return j + 1;
        }
    }

    return src.length;
}

/** Skip a `${…}` expression's inside, from just after `${`; answers the index after its `}`. */
function skipExpression(src: string, i: number): number {
    let depth = 1;

    for (let j = i; j < src.length; j++) {
        const c = src[j]!;

        if (c === '"' || c === "'" || c === "`") {
            j = skipString(src, j) - 1;
        } else if (c === "/" && src[j + 1] === "/") {
            j = src.indexOf("\n", j);
        } else if (c === "/" && src[j + 1] === "*") {
            j = src.indexOf("*/", j) + 1;
        } else if (c === "{") {
            depth++;
        } else if (c === "}" && --depth === 0) {
            return j + 1;
        }
    }

    return src.length;
}

/** The static pieces of one `html` template starting at `i` (its backtick), and the index after it. */
function pieces(src: string, i: number): { parts: { start: number; end: number }[]; next: number } {
    const parts: { start: number; end: number }[] = [];
    let start = i + 1;

    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") {
            j++;
        } else if (src[j] === "$" && src[j + 1] === "{") {
            parts.push({ start, end: j });
            j = skipExpression(src, j + 2) - 1;
            start = j + 1;
        } else if (src[j] === "`") {
            parts.push({ start, end: j });

            return { parts, next: j + 1 };
        }
    }

    return { parts, next: src.length };
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every people-facing text in `src`'s `html` templates. */
export function scan(src: string): Found[] {
    const found: Found[] = [];
    const starts: number[] = [];

    for (const match of src.matchAll(/\bhtml`/g)) {
        starts.push(match.index! + 4);
    }

    for (const at of starts) {
        const { parts } = pieces(src, at);
        // Whether the piece starts inside a tag (after `<div ${…}`, say) or in text.
        let inTag = false;

        parts.forEach((part, index) => {
            const text = src.slice(part.start, part.end);
            const startsInTag = inTag;
            const lastOpen = text.lastIndexOf("<");
            const lastClose = text.lastIndexOf(">");

            if (lastOpen !== -1 || lastClose !== -1) {
                inTag = lastOpen > lastClose;
            }

            // Attributes with a plain value.
            for (const match of text.matchAll(/(\s)([a-z-]+)="([^"$]*)"/g)) {
                if (ATTRS.has(match[2]!) && WORDY.test(match[3]!)) {
                    const start = part.start + match.index! + match[1]!.length;

                    found.push({ kind: "attr", attr: match[2]!, text: collapse(match[3]!), start, end: start + match[0].length - match[1]!.length, line: lineOf(src, start) });
                }
            }

            // Text between a tag's end and the next tag's start, in this piece, or running into an expression.
            const re = />([^<>]*?)(?=<|$)/g;

            for (const match of text.matchAll(re)) {
                const body = match[1]!;

                if (!WORDY.test(body)) {
                    continue;
                }

                const open = part.start + match.index! + 1;
                const close = open + body.length;
                const touchesEnd = close === part.end && index < parts.length - 1;
                const touchesStart = false;

                if (touchesEnd || touchesStart) {
                    found.push({ kind: "mixed", text: collapse(body), start: open, end: close, line: lineOf(src, open) });
                    continue;
                }

                const lead = /^[ \t]*/.exec(body)![0];
                const trail = /[ \t]*$/.exec(body)![0];

                found.push({ kind: "text", text: collapse(body), start: open, end: close, line: lineOf(src, open), lead: /\n/.test(body.slice(0, body.search(/\S/))) ? "" : lead, trail: /\n/.test(body.slice(body.search(/\S\s*$/) + 1)) ? "" : trail });
            }

            // Text after an expression, up to the next tag: the end of a sentence built in pieces.
            if (index > 0 && !startsInTag) {
                const head = /^([^<>]*?)(?=<|$)/.exec(text);

                if (head !== null && WORDY.test(head[1]!)) {
                    found.push({ kind: "mixed", text: collapse(head[1]!), start: part.start, end: part.start + head[1]!.length, line: lineOf(src, part.start) });
                }
            }
        });
    }

    return found.sort((a, b) => a.start - b.start);
}

/** Put the plain texts and attributes of `src` in `t()`; mixed ones stay for a person. */
export function wrap(src: string): { out: string; wrapped: number; mixed: Found[] } {
    const found = scan(src);
    let out = "";
    let at = 0;
    let wrapped = 0;

    for (const each of found) {
        if (each.kind === "mixed") {
            continue;
        }

        out += src.slice(at, each.start);

        if (each.kind === "attr") {
            out += `${each.attr}=\${t(${JSON.stringify(each.text)})}`;
        } else {
            out += `${each.lead ?? ""}\${t(${JSON.stringify(each.text)})}${each.trail ?? ""}`;
        }

        at = each.end;
        wrapped++;
    }

    out += src.slice(at);

    return { out, wrapped, mixed: found.filter((each) => each.kind === "mixed") };
}

if (process.argv[2] === "--wrap") {
    for (const file of process.argv.slice(3)) {
        const { out, wrapped, mixed } = wrap(readFileSync(file, "utf8"));

        writeFileSync(file, out);
        console.log(`${file}: ${wrapped} wrapped; ${mixed.length} to write as whole sentences by hand`);

        for (const each of mixed) {
            console.log(`  ${file}:${each.line} ${JSON.stringify(each.text)}`);
        }
    }
}

// The conversation, as a column of turns: a person's message, then what Pi did (its thinking and tool calls folded
// into one line that opens into a timeline), then Pi's reply, any approval, and the live line while Pi works.
import { Component } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { initials, personColor } from "./avatar.js";
import { routeSliding } from "./back.js";
import { describeCall, describersRevision } from "./calls.js";
import { DiffBlock } from "./diff.js";
import { fromServer } from "./seen.js";
import { LinkedSessions } from "./linked-sessions.js";
import { Highlighted } from "./rich.js";
import {
    actions,
    api,
    attempt,
    browserApi,
    canSteer,
    collab,
    discuss,
    isRow,
    navigate,
    notify,
    openSheet,
    piBrowserState,
    setPiBrowser,
    store,
    TRANSCRIPT_ROWS,
} from "./store.js";
import { setBrowserOpen } from "./browser-panel.js";
import { CrdConnectForm } from "./crd-connect.js";
import { BrowserRunCard } from "./browser-run-card.js";
import { ScreenCard } from "./guide.js";
import { openSubagent, stateOf } from "./subagents.js";
import { prefs } from "./theme.js";
import {
    diffCounts,
    itemsOf,
    lineCount,
    matchCount,
    rowsBefore,
    says,
    short,
    shortError,
    STOPPED,
    summarize,
    testOutcome,
    withoutNotes,
} from "./turns.js";
import {
    Boot,
    Choice,
    clockTime,
    copyText,
    entryImageUrl,
    fileUrl,
    html,
    Icon,
    Linked,
    Markdown,
    openFile,
    plainText,
    readable,
    replyText,
    Spinner,
    splitAttachments,
    Thumb,
} from "./ui.js";
import { LimitSwitch, windowName } from "./usage.js";
import { t, tn, tx } from "./i18n.js";

const REPORT = /^\[subagent (\S+) (answered|failed)([^\]]*)\]\s?([\s\S]*)$/;
/** Where the next report starts, in a message of several that arrived together (`extensions/subagents.ts`). */
const NEXT_REPORT = /\n\n(?=\[subagent \S+ (?:answered|failed))/;

/** How a scheduled message starts (see src/server/schedules.ts). */
const SCHEDULED = "[scheduled] ";
/** How a message spoken in a voice call starts (`VOICE_PREFIX`, src/server/entry-format.ts). */
const VOICE = "[voice] ";

/** A message the app sent for a person, and what sent it: PiP, a PR watch, a webhook (`submit` in src/server/commands.ts). */
const VIA = /^\[via ([^\]\n]{1,300})\] /;
// A project team's report: from a task's session ("TD-4 · task session #22858"), the board, or the project. Sent in the
// name of the person the run works for, but shown as from where it came.
const TEAM_VIA = /^(?:(?:([A-Z][A-Z0-9]{1,5}-\d+) · )?task session #(\d+)|the board|project ([A-Z][A-Z0-9]{1,5}))$/;
/** What came from outside in such a message, fenced as data for Pi: a check's log, a webhook's post, GitHub's events. */
const FENCED =
    /<(ci-log|webhook-payload|github-event)((?: [a-z]+="[^"\n]*")*)>\n([\s\S]*?)\n<\/\1>/g;
const FENCE_LABELS = { "webhook-payload": () => t("What was posted"), "github-event": () => t("On GitHub") };

/** A message from the app with what it fenced for Pi shown as blocks of its own, named after what each is. */
function FencedText({ text }) {
    const parts = [];
    let last = 0;

    for (const match of text.matchAll(FENCED)) {
        const name = /"([^"]*)"/.exec(match[2])?.[1];
        const label =
            match[1] === "ci-log"
                ? t("Log of {name}", { name: name ?? t("a check") })
                : match[1] === "github-event"
                  ? name
                      ? t("On GitHub: {name}", { name })
                      : t("On GitHub")
                  : (name ?? FENCE_LABELS[match[1]]?.());

        parts.push(
            html`<${MentionedText} text=${text.slice(last, match.index).replace(/\n$/, "")} />`,
        );
        parts.push(html`<div class="fenced-data">
            <div class="fenced-label">${label}</div>
            <pre>${readable(match[3])}</pre>
        </div>`);
        last = match.index + match[0].length;
    }

    parts.push(html`<${MentionedText} text=${text.slice(last).replace(/^\n\n?/, "")} />`);

    return parts;
}

/** A goal's check that did not pass, as Pi is told about it (see src/server/extensions/goals.ts): what, then its output. */
const GOAL_CHECK =
    /^\[goal\] `([\s\S]*?)` (still fails|was cut off by a server restart) \(([^)]*)\)\. ([\s\S]*)$/;

/** A skill run with `/skill:name`, as Pi gets it (see `expandSkillCommand` in src/server/prompts.ts): its name, file, and the request. */
const SKILL = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** An @mention of a file or folder in a message, as the message box writes it. */
const MENTION = /(^|[\s([{])@(?:"([^"\n]+)"|([^\s"]+))/g;

/** One line of the attachment list the server adds to a message: `- path (name, mime, size bytes)`. */
const ATTACHED = /^- (.*) \(([^,]*), ([^,]*), (\d+) bytes\)$/;

function parseAttachments(block) {
    return block
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const match = ATTACHED.exec(line);

            return match
                ? { path: match[1], name: match[2], mime: match[3] }
                : { name: line.replace(/^- /, ""), mime: "" };
        });
}

function EntryImages({ entryId, count, label }) {
    return html`<div class="thumbs">
        ${Array.from(
            { length: count },
            (_, index) => html`<${Thumb}
                src=${entryImageUrl(entryId, index)}
                alt=${`${label} ${index + 1}`}
            />`,
        )}
    </div>`;
}

function authorName(entryId, view, users) {
    const userId = view.authors?.[entryId];

    if (userId) {
        const user = users.find((each) => each.id === userId);

        return user ? user.name : (store.state.former?.[userId] ?? "Someone");
    }

    return undefined;
}

/** Tapping a message opens what can be done with it, unless the tap was on a link, an image, or a button in it, or ended a text selection. */
function openMessage(event, entryId) {
    if (event.target.closest("a, button") || getSelection()?.toString()) {
        return;
    }

    openSheet({ type: "message", entryId });
}

/**
 * The conversation whose first rows have rendered: rows that mount after that are new (a message sent, a report
 * arriving) and slide into place. Rows already there when a session opens just appear.
 */
let settledFor = null;

/** A message's text with its @mentions of files as buttons that open them. Mentions of people stay text. */
function MentionedText({ text }) {
    const parts = [];
    let last = 0;

    for (const match of text.matchAll(MENTION)) {
        const quoted = match[2] !== undefined;
        const path = quoted ? match[2] : match[3].replace(/[.,;:!?)\]}'`]+$/, "");

        if (!quoted && !/[./]/.test(path)) {
            continue;
        }

        const at = match.index + match[1].length;
        const written = quoted ? `@"${path}"` : `@${path}`;

        parts.push(text.slice(last, at));
        parts.push(
            html`<button
                class="file-mention"
                title=${t("Open {path}", { path })}
                onClick=${() => openFile(path)}
            >
                ${written}
            </button>`,
        );
        last = at + written.length;
    }

    parts.push(text.slice(last));

    return parts;
}

/** A subagent's report: who, whether it answered or failed, and what it said. */
function Report({ report, view, fresh }) {
    const [, name, verb, after, text] = report;
    const child = view.subagents.find((agent) => agent.name === name);
    // A failed one says why: "failed: stopped before it answered", "failed: Bad request".
    const why = verb === "failed" ? after.replace(/^:\s*/, "") : "";

    return html`<div
        class=${`report ${verb === "failed" ? "failed" : ""} ${fresh ? "enter" : ""}`}
    >
        <div class="report-head">
            <span class="report-name">${name}</span> ${verb}
            ${
                child &&
                html`<button class="link" onClick=${() => openSubagent(child.conversationId)}>
                    ${t("Open →")}
                </button>`
            }
        </div>
        ${why && html`<div class="report-why">${why}</div>`}
        ${text && html`<${Collapsible} text=${text} />`}
    </div>`;
}

/** A span of time: "18s", "2m 04s", "1h 02m". */
function span(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return t("{n}s", { n: seconds });
    }

    if (seconds < 3600) {
        return t("{m}m {s}s", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") });
    }

    return t("{h}h {m}m", { h: Math.floor(seconds / 3600), m: String(Math.floor(seconds / 60) % 60).padStart(2, "0") });
}

/** When a message was sent, from the server's time: "10:42" today, "Oct 3 10:42" before. */
const clock = (at) => clockTime(new Date(fromServer(at)));

/**
 * A person's message: a filled row with a prompt mark, the accent's for your own and the author's color for someone
 * else's, then who sent it and when, and what they wrote.
 */
function UserEntry({ entry, view, users }) {
    const [fresh] = useState(() => settledFor !== null && settledFor === view.conversation?.id);

    // A report has nobody's name on it: a person's message that looks like one is theirs.
    if (REPORT.test(entry.text) && entry.from === undefined && !view.authors?.[entry.id]) {
        // Several that arrived together came as one message: a card each. A part that is not a report's start is
        // more of the report before it.
        const parts = [];

        for (const part of entry.text.split(NEXT_REPORT)) {
            if (parts.length > 0 && !REPORT.test(part)) {
                parts[parts.length - 1] += `\n\n${part}`;
            } else {
                parts.push(part);
            }
        }

        const reports = parts.map((part) => REPORT.exec(part)).filter(Boolean);

        return reports.length === 1
            ? html`<${Report} report=${reports[0]} view=${view} fresh=${fresh} />`
            : html`<div class="report-group">
                  ${reports.map((report) => html`<${Report} report=${report} view=${view} fresh=${fresh} />`)}
              </div>`;
    }

    const check = GOAL_CHECK.exec(entry.text);

    if (check) {
        const [, command, what, how, output] = check;

        return html`<div class="report failed">
            <div class="report-head">
                <span class="report-name mono">${command}</span> ${what} · ${how}
            </div>
            <${Collapsible} text=${output} limit=${300} />
        </div>`;
    }

    const authorId = view.authors?.[entry.id];
    const author =
        authorName(entry.id, view, users) ??
        entry.from ??
        (view.conversation?.kind === "subagent" ? t("Main agent") : undefined);
    const [written, attachments] = splitAttachments(entry.text);
    // Set up earlier to go out now: by a person (who shows as its author) or by Pi.
    // Only a message nobody typed: someone writing "[via …]" themselves gets no label.
    const via = authorId === undefined ? VIA.exec(written) : null;
    const sent = via ? written.slice(via[0].length) : written;
    const scheduled = sent.startsWith(SCHEDULED);
    // Spoken in a voice call (PP-185): marked voice, as speech-to-text may have misheard.
    const spoken = !scheduled && sent.startsWith(VOICE);
    // A linked session's message: shown by its label and its fence alone, so the words before the fence (which tell Pi
    // how to read it) can change without changing how older messages show.
    const peerText =
        via && /^linked session \S+$/.test(via[1])
            ? /\n<linked-session-message>\n([\s\S]*)\n<\/linked-session-message>$/.exec(sent)?.[1]
            : undefined;
    const body = peerText ?? (scheduled ? sent.slice(SCHEDULED.length) : spoken ? sent.slice(VOICE.length) : sent);
    const files = attachments ? parseAttachments(attachments) : [];
    // `/skill:name request`: the skill by name, and the request.
    const skill = SKILL.exec(body);
    const pictures = files.filter((file) => file.path && file.mime.startsWith("image/"));
    const others = files.filter((file) => !pictures.includes(file));
    const team = via && !scheduled ? TEAM_VIA.exec(via[1]) : null;
    const name = team
        ? team[2]
            ? (team[1] ?? t("Task session"))
            : team[3]
              ? t("Project {key}", { key: team[3] })
              : t("The board")
        : (author ?? (scheduled ? "Pi" : undefined));
    const viaNote = team?.[2] ? t("task session #{n}", { n: team[2] }) : team ? null : via?.[1];
    // Your own messages take the accent; someone else's, their color; one from someone the app does not know (a name
    // the message carries, the main agent, Pi's own schedule), a quiet one.
    const mark =
        !team && (authorId === store.state.me?.id || (authorId === undefined && name === undefined))
            ? "var(--accent)"
            : authorId === undefined
              ? "var(--muted)"
              : personColor(authorId);

    // Who it is from, for themes: you, someone else, a linked session, or no one the app knows (Pi's schedule, the main
    // agent, a watch or a webhook).
    const from =
        peerText !== undefined
            ? "linked"
            : team
              ? "team"
              : authorId === undefined
              ? "other"
              : authorId === store.state.me?.id
                ? "me"
                : "person";

    return html`<div
        class=${`user-row ${fresh ? "enter" : ""}`}
        data-part="prompt-row"
        id=${`entry-${entry.id}`}
    >
        <div
            class="prompt tappable"
            data-part="prompt"
            data-from=${from}
            title=${t("Edit, send again, or copy")}
            tabindex="0"
            onClick=${(event) => openMessage(event, entry.id)}
            onKeyDown=${(event) => {
                if (
                    (event.key === "Enter" || event.key === " ") &&
                    event.target === event.currentTarget
                ) {
                    event.preventDefault();
                    openMessage(event, entry.id);
                }
            }}
        >
            <span class="prompt-head" data-part="prompt-head">
                <span
                    class="prompt-avatar"
                    data-part="author-mark"
                    style=${`--who:${mark}`}
                    aria-hidden="true"
                >
                    ${team ? html`<${Icon} name="board" size=${12} />` : name ? initials(name) : "›"}
                </span>
                ${name && html`<b class="prompt-author" data-part="prompt-author">${name}</b>`}
                ${entry.at && html`<span class="prompt-time">${clock(entry.at)}</span>`}
                ${scheduled && html`<span class="prompt-time">· ${t("scheduled")}</span>`}
                ${spoken && html`<span class="prompt-time voice-mark" data-part="voice-mark">· <${Icon} name="mic" size=${11} /> ${t("voice")}</span>`}
                ${via && viaNote && html`<span class="prompt-time">· ${team ? (peerText === undefined ? viaNote : t("a linked session")) : t("via {where}", { where: peerText === undefined ? viaNote : t("a linked session") })}</span>`}
            </span>
            <div class="prompt-body" data-part="prompt-text">
                ${
                    skill &&
                    html`<button
                        class="chip skill-chip"
                        title=${skill[2]}
                        onClick=${() => openFile(skill[2])}
                    >
                        ⚡ ${skill[1]}
                    </button>`
                }
                ${
                    (skill ? skill[3] : body) &&
                    html`<div class="user-text">
                        ${
                            via
                                ? html`<${FencedText} text=${body} />`
                                : html`<${MentionedText} text=${skill ? skill[3] : body} />`
                        }
                    </div>`
                }
                ${
                    entry.files?.length > 0 &&
                    html`<div class="attachments">
                        ${entry.files.map(
                            (path) =>
                                html`<button
                                    class="chip"
                                    title=${t("Sent with the message: {path}", { path })}
                                    onClick=${() => openFile(path)}
                                >
                                    📄 ${path.split("/").pop()}
                                </button>`,
                        )}
                    </div>`
                }
                ${
                    pictures.length > 0 &&
                    html`<div class="thumbs">
                        ${pictures.map(
                            (file) => html`<${Thumb} src=${fileUrl(file.path)} alt=${file.name} />`,
                        )}
                    </div>`
                }
                ${
                    others.length > 0 &&
                    html`<div class="attachments">
                        ${others.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}
                    </div>`
                }
                ${
                    entry.images > 0 &&
                    !attachments &&
                    html`<${EntryImages} entryId=${entry.id} count=${entry.images} label=${t("Image")} />`
                }
            </div>
        </div>
    </div>`;
}

function Collapsible({ text, limit = 600 }) {
    const [open, setOpen] = useState(false);

    if (text.length <= limit) {
        return html`<${Markdown} text=${text} />`;
    }

    return html`<div class=${`collapsible ${open ? "open" : ""}`}>
        <${Markdown} text=${open ? text : `${text.slice(0, limit)}…`} />
        <button class="link" onClick=${() => setOpen(!open)}>
            ${open ? t("Show less") : t("Show more")}
        </button>
    </div>`;
}

// ─── What Pi did: its thinking and tool calls, a line each on a timeline ───────────────

/** What a step's mark says, by how the call went; a call still running shows a spinner instead. */
// Drawn, not typed: a font draws these glyphs thin and off center in a 19px circle.
const markSvg = (body) => html`<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CROSS = markSvg(html`<path d="M2.8 2.8l4.4 4.4M7.2 2.8L2.8 7.2" />`);
const MARKS = {
    done: markSvg(html`<path d="M2.2 5.3l1.9 1.9 3.7-4.2" />`),
    error: CROSS,
    denied: CROSS,
    stopped: markSvg(html`<path d="M2.6 5h4.8" />`),
    approval: markSvg(html`<path d="M5 2.2v3.3" stroke-width="1.9" /><circle cx="5" cy="7.8" r="1.05" fill="currentColor" stroke="none" />`),
};

/** A step's mark: a small circle that says how it went. A thought is ✦, and a subagent's call ⑂ unless it failed. */
function StepMark({ status, kind }) {
    const agent = kind === "agent" && (status === "done" || status === "running");
    const spinning = kind !== "thought" && !agent && status === "running";
    // "asking" and "spinning", not "approval" and "running": those are cards' classes, whose padding and border would land on the circle.
    const look = kind === "thought" ? "thought" : agent ? "agent" : status === "approval" ? "asking" : status === "running" ? "spinning" : status;
    const mark = kind === "thought" ? "✦" : agent ? "⑂" : MARKS[status];

    return html`<span
        class=${`step-mark ${look}`}
        data-part="step-mark"
        aria-hidden=${spinning ? undefined : "true"}
    >
        ${spinning ? html`<${Spinner} />` : mark}
    </span>`;
}

/** What Pi did with its memory tool, as a step's label. */
const MEMORY_WORDS = () => ({
    add: t("saved a lesson"),
    update: t("changed a lesson"),
    remove: t("forgot a lesson"),
    list: t("read its lessons"),
});

/** A call's line: its label (the tool, or a subagent's name) and what it acts on. */
function stepWords(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "grep":
        case "find":
            return {
                label: call.name,
                subject: [args.pattern, args.path].filter(Boolean).join("  "),
            };
        case "subagent":
            return {
                label: args.name ?? "subagent",
                subject: args.message ? short(args.message) : (args.action ?? ""),
            };
        case "browser":
            return {
                label: "browser",
                subject: `${args.action ?? ""} ${describeCall(call).subject}`.trim(),
            };
        case "memory":
            return {
                label: MEMORY_WORDS()[args.action] ?? t("memory"),
                subject: args.text ? short(args.text) : (args.id ?? ""),
            };
        case "watch_pr":
            return { label: "watch PR", subject: [args.action, args.pr].filter(Boolean).join(" ") };
        case "image_generate":
            return { label: call.name, subject: args.prompt ? short(args.prompt) : "" };

        default: {
            const described = describeCall(call);

            // An extension's own words for its tool, or the tool's name.
            return {
                label: described.own ? described.label : call.name,
                subject: described.subject,
            };
        }
    }
}

/**
 * What a call came to, on the right of its line: `{ text, tone }`, or null while it runs or when there is nothing to
 * say.
 */
function outcome({ call, result, details, status }) {
    if (status === "approval") {
        return { text: t("needs approval"), tone: "warn" };
    }

    if (status === "denied" || status === "stopped") {
        return {
            text: /was interrupted/.test(result?.text ?? "") ? t("cut off by a restart") : status === "denied" ? t("denied") : t("stopped"),
            tone: "",
        };
    }

    if (status === "error") {
        return { text: shortError(result?.text ?? ""), tone: "err" };
    }

    // A call whose result is not stored yet has nothing to count.
    if (status !== "done" || !result) {
        return null;
    }

    const text = result.text ?? "";
    const args = call.args ?? {};

    switch (call.name) {
        case "edit": {
            const counts = diffCounts(details?.diff);

            return counts && { text: `+${counts.added} −${counts.removed}`, tone: "ok", counts };
        }

        case "write":
            return typeof args.content === "string" && !call.clipped?.content
                ? { text: `+${lineCount(args.content)}`, tone: "ok" }
                : null;

        case "read": {
            // Without the notes a long file's read ends with: "[120 more lines in file. Use offset=…]".
            const read = withoutNotes(text).replace(
                /\n*\[[^\]\n]*(?:more lines|offset=)[^\]\n]*\]\s*$/,
                "",
            );

            return result.images > 0
                ? { text: t("image"), tone: "" }
                : !result.clipped && { text: tn(lineCount(read), "{n} line", "{n} lines"), tone: "" };
        }

        // A long result reaches the browser cut short (its start and end): its lines cannot be counted.
        case "grep":
            return /^No matches/.test(text)
                ? { text: t("no matches"), tone: "" }
                : {
                      text: result.clipped ? t("many matches") : tn(matchCount(withoutNotes(text)), "{n} match", "{n} matches"),
                      tone: "",
                  };
        case "find":
        case "ls":
            return /^(?:No files|\(empty directory\))/.test(text)
                ? { text: t("none"), tone: "" }
                : {
                      text: result.clipped
                          ? t("many")
                          : call.name === "ls"
                            ? tn(lineCount(withoutNotes(text)), "{n} entry", "{n} entries")
                            : tn(lineCount(withoutNotes(text)), "{n} file", "{n} files"),
                      tone: "",
                  };

        case "bash": {
            const tests = testOutcome(text, args.command);

            if (tests) {
                return { text: tests, tone: "ok" };
            }

            const lines = lineCount(withoutNotes(text).trim());

            return {
                text: result.clipped ? t("long output") : lines === 0 ? t("no output") : tn(lines, "{n} line", "{n} lines"),
                tone: "",
            };
        }

        case "artifact":
            return details?.version !== undefined
                ? { text: `v${details.version}`, tone: "" }
                : null;
        case "codemode":
            return Array.isArray(details?.calls) ? { text: tn(details.calls.length, "{n} call", "{n} calls"), tone: "" } : null;
        // Images made (PP-275): how many, and what they cost (a count on the ChatGPT plan).
        case "image_generate":
            return Array.isArray(details?.images)
                ? {
                      text: [
                          tn(details.images.length, "{n} image", "{n} images"),
                          typeof details.cost === "number" ? `$${details.cost < 0.01 && details.cost > 0 ? details.cost.toFixed(4) : details.cost.toFixed(2)}` : details.plan === "chatgpt" ? t("ChatGPT plan") : "",
                      ]
                          .filter(Boolean)
                          .join(" · "),
                      tone: "",
                  }
                : null;

        case "subagent": {
            const agent = store.state.view.subagents?.find((each) => each.name === args.name);

            if (
                !agent ||
                (args.action !== undefined && args.action !== "spawn" && args.action !== "send")
            ) {
                return null;
            }

            const state = stateOf(agent);
            const took =
                state !== "working" && agent.askedAt && agent.answeredAt
                    ? ` ${span(agent.answeredAt - agent.askedAt)}`
                    : "";

            return { text: `${state}${took}`, tone: state === "failed" ? "err" : "" };
        }

        default:
            return null;
    }
}

/** A call's state for themes (`data-state`), by its status: documented names that stay when the statuses change. */
const CALL_STATES = {
    approval: "waiting",
    denied: "denied",
    running: "running",
    done: "ok",
    error: "failed",
    stopped: "stopped",
};

/**
 * Who allowed or denied a call. A script's own calls are asked about one by one (`<call>/<n>`): for the script, the one
 * denied when it failed, or else the last one allowed.
 */
function decisionOf(decisions, call, result) {
    const own = decisions?.[call.id];

    if (own !== undefined || call.name !== "codemode") {
        return own;
    }

    const inner = Object.entries(decisions ?? {}).flatMap(([id, each]) =>
        id.startsWith(`${call.id}/`) ? [each] : [],
    );

    return (
        (result?.isError ? inner.find((each) => each.allow === false) : undefined) ??
        inner.findLast((each) => each.allow !== false)
    );
}

/**
 * Where a call is: waiting for approval, denied, running, done, failed, or stopped before it finished. A call with
 * nothing to say for it yet runs while it is being written, or while Pi works on the answer that asked for it
 * (`canRun`); any other never will.
 */
function callStatus({ result, slot, approval, decision, streaming, canRun, busy }) {
    if (approval) {
        return "approval";
    }

    if (decision?.allow === false) {
        return "denied";
    }

    if (result) {
        // Stopped with the run, or cut off by a restart: the harness says so in its own words.
        if (result.isError && STOPPED.test(result.text ?? "")) {
            return "stopped";
        }

        return result.isError ? "error" : "done";
    }

    if (slot) {
        return slot.status === "done" ? "done" : "running";
    }

    return streaming || (busy && canRun) ? "running" : "stopped";
}

/**
 * `unrolling` for what a person opened just now (`unrolled`, when they tapped it): it unrolls (style.css). What opens by
 * itself, as a session opens or a group goes live, shows at once. Never tapped is -Infinity, not 0: the page's clock
 * starts at 0 as it loads, so 0 would read as a tap just now.
 */
const unrolling = (unrolled) => (performance.now() - unrolled.current < 600 ? "unrolling" : "");

/** A thought, on the timeline: open it to read it. */
function ThoughtStep({ block, streaming, reading }) {
    // With Show thinking on, a thought once written shows its words (the live line shows the one being written).
    const [chosen, setChosen] = useState(null);
    const unrolled = useRef(-Infinity);
    const open = chosen ?? (reading && !streaming && Boolean(block.text?.trim()));

    return html`<div
        class=${`step ${open ? "open" : ""}`}
        data-part="thinking"
        data-status=${streaming ? "running" : "done"}
    >
        <div class="step-line">
            <button
                class="step-head"
                data-part="step-head"
                aria-expanded=${open}
                onClick=${() => {
                    unrolled.current = open ? -Infinity : performance.now();
                    setChosen(!open);
                }}
            >
                <${StepMark} status=${streaming ? "running" : "done"} kind="thought" />
                <span class="step-label" data-part="step-label">
                    ${streaming ? t("Thinking") : block.redacted ? t("Thought (redacted)") : t("Thought")}
                </span>
                <span class="step-subject"></span>
                ${streaming && html`<${Spinner} label=${t("Thinking")} />`}
            </button>
        </div>
        ${
            open &&
            html`<div class=${`step-body ${unrolling(unrolled)}`} data-part="step-detail">
                <div class="thought-body">${block.text}</div>
            </div>`
        }
    </div>`;
}

/** One tool call on the timeline: what it did and how it went, and tapped, its input and output. */
function ToolStep({
    call,
    result,
    slot,
    approval,
    entryId,
    streaming,
    canRun,
    busy,
    conversationId,
}) {
    const [open, setOpen] = useState(false);
    const unrolled = useRef(-Infinity);
    const [full, setFull] = useState(null);
    const view = store.state.view;
    const decision = decisionOf(view.decisions, call, result);
    const status = callStatus({ result, slot, approval, decision, streaming, canRun, busy });
    // A call that finishes while on screen flashes once.
    const [settled, setSettled] = useState(false);
    const was = useRef(status);

    useEffect(() => {
        const before = was.current;

        was.current = status;

        if (status !== "done" || before !== "running") {
            return;
        }

        setSettled(true);
        const timer = setTimeout(() => setSettled(false), 900);

        return () => clearTimeout(timer);
    }, [status]);
    const details = full?.result?.details ?? result?.details ?? slot?.details;
    const args = (full?.call ?? call).args ?? {};
    const resultText = full?.result?.text ?? result?.text;
    // A long edit's diff reaches the browser cut short, as its start and end (`projection.ts`), with no other sign.
    const diffClipped =
        typeof details?.diff === "string" &&
        /\n\n… \d+ characters not shown …\n\n/.test(details.diff);
    const loadFull = () =>
        attempt(async () => {
            const assistant = await actions.fullEntry(entryId);
            const fullCall = assistant.blocks?.find(
                (block) => block.type === "toolCall" && block.id === call.id,
            );
            const fullResult =
                (result?.clipped || diffClipped) && result
                    ? await actions.fullEntry(result.id)
                    : null;

            setFull({ call: fullCall ?? call, result: fullResult });
        });

    let body = null;

    if (open) {
        const clipped = (call.clipped || result?.clipped || diffClipped) && !full;
        const parts = [];

        if (
            (call.name === "read" || call.name === "write" || call.name === "edit") &&
            typeof args.path === "string" &&
            args.path !== ""
        ) {
            const at = call.name === "read" && args.offset ? `:${args.offset}` : "";

            parts.push(
                html`<button
                    class="link small tool-open"
                    onClick=${() => openFile(`${args.path}${at}`)}
                >
                    ${t("Open {name} →", { name: args.path.split("/").pop() })}
                </button>`,
            );
        }

        if (call.name === "bash") {
            parts.push(html`<pre class="cmd">$ ${args.command}</pre>`);
        }

        if (call.name === "write" && args.content) {
            parts.push(
                html`<${Highlighted} class="output" text=${args.content} lang=${args.path} />`,
            );
        }

        if (call.name === "edit") {
            if (details?.diff) {
                parts.push(
                    html`<${DiffBlock} text=${details.diff} path=${args.path ?? ""} bare=${true} />`,
                );
            } else if (Array.isArray(args.edits)) {
                parts.push(
                    html`<pre class="output">
                        ${args.edits.map((edit) => `- ${edit.oldText}\n+ ${edit.newText}`).join("\n\n")}
                    </pre>`,
                );
            }
        }

        if (call.name === "subagent" && args.message) {
            parts.push(html`<div class="tool-note"><${Linked} text=${args.message} /></div>`);
        }

        if (call.name === "codemode") {
            if (args.code) {
                parts.push(html`<pre class="cmd">${args.code}</pre>`);
            }

            // The script's own tool calls, live while it runs.
            const nested = Array.isArray(details?.calls) ? details.calls : [];

            if (nested.length > 0) {
                parts.push(
                    html`<div class="nested-calls">
                        ${nested.map(
                            (each) => html`<div class=${`nested-call ${each.status}`}>
                                <span class="nested-status">
                                    ${each.status === "ok" ? "✓" : each.status === "running" ? "…" : each.status === "cancelled" ? "–" : "!"}
                                </span>
                                <span class="mono">${each.name}</span>
                                ${
                                    each.durationMs !== undefined &&
                                    html`<span class="muted">${t("{n} ms", { n: each.durationMs })}</span>`
                                }
                                ${
                                    each.error &&
                                    html`<span class="nested-error">${each.error}</span>`
                                }
                            </div>`,
                        )}
                    </div>`,
                );
            }
        }

        if (call.name === "artifact" && (args.content || args.edits)) {
            parts.push(
                html`<pre class="output">
                    ${args.content ?? JSON.stringify(args.edits, null, 2)}
                </pre>`,
            );
        }

        if (call.name === "browser") {
            parts.push(
                args.script
                    ? html`<pre class="cmd">${args.script}</pre>`
                    : html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`,
            );
        }

        if (
            ![
                "read",
                "write",
                "edit",
                "bash",
                "subagent",
                "artifact",
                "codemode",
                "browser",
            ].includes(call.name)
        ) {
            parts.push(html`<pre class="output">${JSON.stringify(args, null, 2)}</pre>`);
        }

        // The harness's own errors come wrapped in its tags, after the output if any: what it says is inside them.
        const output = (resultText ?? slot?.output)
            ?.replace(
                /(^|\n)<harness>([\s\S]*?)<\/harness>\s*$/,
                (_, before, note) => before + note.trim(),
            )
            .replace(/^<harness>\s*/, "");

        if (output && !(call.name === "edit" && details?.diff && !result?.isError)) {
            parts.push(
                html`<pre class=${`output ${result?.isError ? "error" : ""}`}>${output}</pre>`,
            );
        }

        // A call still streaming has no stored entry to load yet.
        if (clipped && entryId !== undefined) {
            parts.push(html`<button class="link" onClick=${loadFull}>${t("Load everything")}</button>`);
        }

        body = html`<div class=${`step-body ${unrolling(unrolled)}`} data-part="step-detail">
            ${parts}
        </div>`;
    }

    const child =
        call.name === "subagent"
            ? (details?.conversationId ??
              view.subagents.find((agent) => agent.name === args.name)?.conversationId)
            : undefined;
    const { label, subject } = stepWords(call);
    // Counted from everything once it is loaded: a long write's lines, a long edit's whole diff.
    const said = outcome({
        call: full?.call ?? call,
        result: full?.result ?? result,
        details,
        status,
    });
    // What a call made shows under its line: the images it returned, and an artifact it published.
    const artifact = call.name === "artifact" && details?.id ? details : null;
    const artifactType = artifact
        ? view.artifacts.find((each) => each.id === artifact.id)?.type
        : undefined;
    const artifactSrc = artifact
        ? `a/${view.conversation.id}/${encodeURIComponent(artifact.id)}/${artifact.version}`
        : null;
    // The images image_generate saved (PP-275): shown from their files, as Pi got only their paths.
    const made = call.name === "image_generate" && Array.isArray(details?.images) ? details.images : [];
    const extras = result?.images > 0 || artifact || made.length > 0;

    return html`<div
        class=${`step ${open ? "open" : ""} ${settled ? "settled" : ""}`}
        data-part="tool-call"
        data-state=${CALL_STATES[status]}
        data-status=${status}
    >
        <div class="step-line">
            <button
                class="step-head"
                data-part="step-head"
                aria-expanded=${open}
                onClick=${() => {
                    unrolled.current = open ? -Infinity : performance.now();
                    setOpen(!open);
                }}
            >
                <${StepMark} status=${status} kind=${call.name === "subagent" ? "agent" : ""} />
                <span class="step-label" data-part="step-label">${label}</span>
                <span class="step-subject">${subject}</span>
                ${
                    said &&
                    html`<span class=${`step-meta ${said.tone}`}>
                        ${
                            said.counts
                                ? html`<span class="ok">+${said.counts.added}</span>${" "}<span class="err">−${said.counts.removed}</span>`
                                : said.text
                        }
                    </span>`
                }
            </button>
            ${
                child !== undefined &&
                html`<button
                    class="step-open"
                    title=${(args.name ?? null) === null ? t("Open the subagent") : t("Open {name}", { name: args.name })}
                    onClick=${() => openSubagent(child)}
                >
                    ${t("Open →")}
                </button>`
            }
        </div>
        ${
            call.name === "browser_run" &&
            html`<${BrowserRunCard} args=${args} status=${status} resultText=${resultText ?? slot?.output} conversationId=${conversationId} />`
        }
        ${call.name === "show_screen" && html`<${ScreenCard} args=${args} />`}
        ${
            decision &&
            html`<div
                class=${`step-decision ${decision.allow ? "allowed" : "denied"}`}
                title=${new Date(decision.at).toLocaleString()}
            >
                <${Icon} name="shield" size=${13} /> ${decided(decision)}
            </div>`
        }
        ${
            extras &&
            html`<div class="step-extras" data-part="step-detail">
                ${
                    result?.images > 0 &&
                    html`<${EntryImages}
                        entryId=${result.id}
                        count=${result.images}
                        label=${`${call.name} image`}
                    />`
                }
                ${
                    made.length > 0 &&
                    html`<div class="thumbs made-images" data-part="made-images">
                        ${made.map(
                            (image) => html`<${Thumb} src=${fileUrl(image.path, conversationId)} alt=${image.path.split("/").pop()} />`,
                        )}
                    </div>`
                }
                ${
                    artifactType === "svg" &&
                    html`<button
                        class="artifact-preview"
                        type="button"
                        onClick=${() => openSheet({ type: "image", src: artifactSrc, alt: artifact.title })}
                    >
                        <img src=${artifactSrc} alt=${artifact.title} loading="lazy" decoding="async" />
                    </button>`
                }
                ${
                    artifact &&
                    html`<button
                        class="artifact-link"
                        onClick=${() => openSheet({ type: "viewer", id: artifact.id, version: artifact.version })}
                    >
                        ${t("Open {title} · version {version} →", { title: artifact.title, version: artifact.version })}
                    </button>`
                }
            </div>`
        }
        ${body}
    </div>`;
}

/** Groups opened or closed by hand, per conversation and group, for as long as the page is open. */
const openedGroups = new Map();
/**
 * The answer a jump asked to see last (`jumpToEntry` in chat.js says so with a `pocket:reveal` event), and when: a group
 * that shows only after the jump moved the rows shown opens when it first draws. Groups already shown hear the event.
 */
let revealing = { entryId: null, at: 0 };

document.addEventListener("pocket:reveal", (event) => {
    revealing = { entryId: event.detail, at: Date.now() };
});
/** When this page first saw a group that began before any of its entries was stored: the start of its clock. */
const groupSeen = new Map();
/** Where a group's clock stood when it last ticked: the end of a group whose stored times do not say. */
const groupTicked = new Map();

/** Keep `value` in one of the maps above, the oldest going once there are many. */
function keep(map, key, value) {
    map.delete(key);
    map.set(key, value);

    if (map.size > 500) {
        map.delete(map.keys().next().value);
    }
}

/**
 * How long a group took, from when its first answer began to its last result; ticking while it is live, without
 * drawing the group again. A group whose stored times do not say how long (a thought, then words) keeps what its clock
 * showed, or shows nothing.
 */
function GroupTime({ id, start, end, live }) {
    const [, tick] = useState(0);

    useEffect(() => {
        if (!live) {
            return;
        }

        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, [live]);

    if (start === undefined) {
        return null;
    }

    let until = end;

    if (live) {
        until = Date.now();
        keep(groupTicked, id, until);
    } else if (!(until > start)) {
        until = groupTicked.get(id);
    }

    if (until === undefined || !Number.isFinite(until) || until < start) {
        return null;
    }

    return html`<span class=${`activity-time ${live ? "live" : ""}`}>${span(until - start)}</span>`;
}

/**
 * Pi's thinking and tool calls between two of its words, as one line: what they did, and how long they took. It opens
 * into a timeline, a line per call, each drawn again only when what it shows changes. Open while it is live or in the
 * newest turn, closed before, unless opened or closed by hand.
 */
function ActivityGroup({
    item,
    live,
    newest,
    after,
    busy,
    results,
    slots,
    approvals,
    conversationId,
}) {
    const id = `${conversationId}:${item.key}`;
    const [, redraw] = useState(0);
    const [fresh] = useState(() => settledFor !== null && settledFor === conversationId);
    // When a click opened it: it unrolls (style.css).
    const unrolled = useRef(-Infinity);

    if (
        revealing.entryId !== null &&
        Date.now() - revealing.at < 2000 &&
        item.anchors.includes(revealing.entryId)
    ) {
        keep(openedGroups, id, true);
    }

    const chosen = openedGroups.get(id);
    const all = item.before.length === 0 ? item.steps : [...item.before, ...item.steps];
    // A thought alone is the group's own line, not a step under a line that says the same: it opens to its words,
    // which stay folded until asked for, as a thought on the timeline does.
    const lone = all.length === 1 && all[0].block.type === "thinking" ? all[0] : null;
    // Show thinking on: thoughts show their words once written.
    const reading = prefs().showThinking === true;
    const open =
        chosen ??
        (lone ? reading && !lone.streaming && Boolean(lone.block.text?.trim()) : live || newest);
    // Calls that failed, said on the line too: folded, "edited 1" alone would read as done. A call someone denied did
    // not fail, nor a script stopped by a denial: its line says who denied it.
    const failed = all.filter((step) => {
        const result = step.block.type === "toolCall" ? results.get(step.block.id) : undefined;

        return (
            result?.isError === true &&
            !STOPPED.test(result.text ?? "") &&
            decisionOf(store.state.view.decisions, step.block, result)?.allow !== false
        );
    }).length;
    const first = all[0];
    let start = first.entry?.at === undefined ? undefined : fromServer(first.entry.at);

    if (start === undefined && first.entry === undefined) {
        if (!groupSeen.has(id)) {
            keep(
                groupSeen,
                id,
                after === undefined ? Date.now() : Math.min(Date.now(), fromServer(after)),
            );
        }

        start = groupSeen.get(id);
    }

    // The last result, or the last answer when the group ends with a thought.
    const times = all
        .flatMap((step) => [
            step.entry?.at,
            step.block.type === "toolCall" ? results.get(step.block.id)?.at : undefined,
        ])
        .filter((at) => at !== undefined);
    const end = times.length === 0 ? undefined : fromServer(Math.max(...times));
    const thinking =
        live && item.steps.at(-1).streaming && item.steps.at(-1).block.type === "thinking";
    // The steps' names, as the timeline draws them (below).
    const keys = new Set();
    // Begun in rows not shown, it goes on from their last call: a thought keeps its name when they show.
    const earlier = item.before.findLast((step) => step.block.type === "toolCall");
    let lastCall = earlier ? `c:${earlier.block.id || "#"}` : "start";
    let thoughts = 0;
    // A jump to one of its answers (Find, a pin, Changes) opens it: `jumpToEntry` says which.
    const anchors = item.anchors.join();

    useEffect(() => {
        if (anchors === "") {
            return;
        }

        const reveal = (event) => {
            if (item.anchors.includes(event.detail)) {
                keep(openedGroups, id, true);
                redraw((n) => n + 1);
            }
        };

        document.addEventListener("pocket:reveal", reveal);

        return () => document.removeEventListener("pocket:reveal", reveal);
    }, [anchors, id]);

    return html`<div
        class=${`activity ${open ? "open" : ""} ${fresh ? "enter" : ""}`}
        data-part="activity"
        data-state=${open ? "open" : undefined}
    >
        ${item.anchors.map(
            (entryId) => html`<span class="entry-anchor" id=${`entry-${entryId}`}></span>`,
        )}
        <button
            class="activity-head"
            data-part="activity-head"
            aria-expanded=${open}
            onClick=${() => {
                unrolled.current = open ? -Infinity : performance.now();
                keep(openedGroups, id, !open);
                redraw((n) => n + 1);
            }}
        >
            <${Icon} name="chevron" size=${14} class="chev" part="activity-chevron" />
            <span class="activity-summary">${summarize(all, thinking)}</span>
            ${failed > 0 && html`<span class="activity-failed">${t("{n} failed", { n: failed })}</span>`}
            <${GroupTime} id=${id} start=${start} end=${end} live=${live} />
        </button>
        ${
            open &&
            lone &&
            html`<div class=${`activity-thought ${unrolling(unrolled)}`}>
                <div class="thought-body">${lone.block.text}</div>
            </div>`
        }
        ${
            open &&
            !lone &&
            html`<div class=${`timeline ${unrolling(unrolled)}`} data-part="timeline">
                ${item.steps.map(({ block, entry, streaming, canRun }, index) => {
                    // A call is named by its id, the same streamed and stored; a thought by the call before it. Not by
                    // place: earlier steps join the front when earlier messages show.
                    if (block.type === "thinking") {
                        return html`<${Memo} key=${`t:${lastCall}:${thoughts++}`} deps=${[block, streaming, reading]}>
                            <${ThoughtStep} block=${block} streaming=${streaming} reading=${reading} />
                        <//>`;
                    }

                    const slot = slots.get(block.id);
                    const approval =
                        slot?.taskId === undefined
                            ? undefined
                            : approvals.find((each) => each.taskId === slot.taskId);
                    let key = `c:${block.id || `#${index}`}`;

                    // A provider can use an id twice, or none.
                    if (keys.has(key)) {
                        key = `${key}#${index}`;
                    }

                    keys.add(key);
                    lastCall = key;
                    thoughts = 0;

                    return html`<${Memo}
                        key=${key}
                        deps=${[
                            block,
                            entry,
                            canRun,
                            busy,
                            conversationId,
                            ...callDeps(block, results, slots, approvals),
                        ]}
                    >
                        <${ToolStep}
                            call=${block}
                            result=${results.get(block.id)}
                            slot=${slot}
                            approval=${approval}
                            entryId=${entry?.id}
                            streaming=${entry === undefined}
                            canRun=${canRun}
                            busy=${busy}
                            conversationId=${conversationId}
                        />
                    <//>`;
                })}
            </div>`
        }
    </div>`;
}

/** Whether a step is still at work: a thought being written, or a call that has not finished. */
function stepLive(step, results, slots, approvals, busy) {
    if (step.block.type === "thinking") {
        return step.streaming;
    }

    const slot = slots.get(step.block.id);
    const approval =
        slot?.taskId === undefined
            ? undefined
            : approvals.find((each) => each.taskId === slot.taskId);
    const status = callStatus({
        result: results.get(step.block.id),
        slot,
        approval,
        decision: store.state.view.decisions?.[step.block.id],
        streaming: step.entry === undefined,
        canRun: step.canRun,
        busy,
    });

    return status === "running" || status === "approval";
}

/** `interview`'s card: Pi's questions wait here, and Answer opens their form. Anyone who can steer answers or skips. */
function InterviewCard({ approval }) {
    const [busy, setBusy] = useState(false);
    const { form } = approval;
    const open = () => openSheet({ type: "interview", conversationId: approval.conversationId, callId: form.callId });
    const skip = () => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, false)).finally(() => setBusy(false));
    };

    return html`<div class="approval interview-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="chat" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${tn(form.count, "Pi has a question: {title}", "Pi has {n} questions: {title}", { title: form.title })}</span>
                ${approval.reason && html`<span class="approval-reason"><${Linked} text=${approval.reason} /></span>`}
            </div>
        </div>
        ${
            canSteer()
                ? html`<div class="approval-actions">
                      <button class="button" disabled=${busy} onClick=${skip}>${t("Skip")}</button>
                      <button class="button primary" onClick=${open}>${t("Answer")}</button>
                  </div>`
                : html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
        }
    </div>`;
}

/**
 * `secret_request`'s card: a hidden field whose value goes to Settings › Secrets, never into the conversation. The
 * owner's to answer; anyone who can steer may decline.
 */
function SecretRequestCard({ approval }) {
    const { me } = store.state;
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const run = (work) => {
        setBusy(true);
        attempt(work).finally(() => setBusy(false));
    };
    const save = () => run(() => actions.answerSecretRequest(approval.id, value));

    return html`<div class="approval" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="key" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${tx("Pi asks for a secret: {name}", { name: html`<span class="mono">${approval.form.name}</span>` })}</span>
                <span class="approval-reason"><${Linked} text=${approval.reason} /></span>
            </div>
        </div>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("The owner keeps secrets: waiting for them to answer.")}</div>`
                : html`<input
                      type="password"
                      class="mono"
                      aria-label=${t("Value of {name}", { name: approval.form.name })}
                      autocomplete="off"
                      placeholder=${t("Paste or type it; it never enters the chat")}
                      value=${value}
                      onInput=${(event) => setValue(event.currentTarget.value)}
                      onKeyDown=${(event) => event.key === "Enter" && value.length >= 8 && save()}
                  />
                  <div class="muted small">
                      ${tx("Saved in Settings › Secrets. Pi uses it as {name} without seeing it.", { name: html`<span class="mono">${approval.form.name}</span>` })}
                  </div>`
        }
        ${
            canSteer() &&
            html`<div class="approval-actions">
                <button class="button deny" disabled=${busy} onClick=${() => run(() => actions.approve(approval.id, false))}>
                    ${t("Decline")}
                </button>
                ${
                    me?.role === "owner" &&
                    html`<button class="button primary" disabled=${busy || value.length < 8} onClick=${save}>
                        ${t("Save secret")}
                    </button>`
                }
            </div>`
        }
    </div>`;
}

/**
 * Pi's browser asks the owner (`extensions/browser.ts`): to sign in, for a one-time code, or to do something on the
 * page themselves. What they type goes into the page, never into the conversation; a sign-in can be kept in Secrets
 * (Remember) and used from there next time. The owner's to answer; anyone who can steer may say not now.
 */
/** A sign-in or code card's field, in the app's own words: never the page's (TannerMidd/pi-pocket-extensions#29). */
const fieldName = (name) => (name === "username" ? t("Username or email") : name === "password" ? t("Password") : t("Code"));

function BrowserAskCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [values, setValues] = useState({});
    const [remember, setRemember] = useState(false);
    const [busy, setBusy] = useState(false);
    const owner = me?.role === "owner";
    const run = (work) => {
        setBusy(true);
        attempt(work).finally(() => setBusy(false));
    };
    const filled = form.fields.every((field) => (values[field.name] ?? "") !== "");
    const send = (body) => run(() => actions.answerBrowserAsk(approval.id, body));
    const title =
        form.kind === "sign-in"
            ? t("Sign in to {site}", { site: form.site })
            : form.kind === "code"
              ? t("A code for {site}", { site: form.site })
              : t("Pi needs your hand on {site}", { site: form.site });

    return html`<div class="approval" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name=${form.kind === "do" ? "globe" : "key"} size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${title}</span>
                <span class="approval-reason">${form.kind === "sign-in" ? t("Pi's browser is at its sign-in. What you type goes into the page; Pi never sees it.") : html`<${Linked} text=${form.instruction} />`}</span>
            </div>
        </div>
        ${
            !owner
                ? html`<div class="muted small">${t("Pi's browser is the owner's: waiting for them.")}</div>`
                : form.kind === "do"
                  ? html`<div class="muted small">${t("Open Pi's browser, do it there (you have the page until you hand it back), then tell Pi it is done.")}</div>`
                  : html`<form
                        class="browser-ask-fields"
                        onSubmit=${(event) => {
                            event.preventDefault();

                            if (filled) {
                                send({ values, remember });
                            }
                        }}
                    >
                        ${form.fields.map(
                            (field) => html`<input
                                type=${field.name === "username" ? "text" : "password"}
                                autocomplete=${field.name === "username" ? "username" : field.name === "password" ? "current-password" : "one-time-code"}
                                inputmode=${field.name === "code" ? "numeric" : undefined}
                                aria-label=${fieldName(field.name)}
                                placeholder=${fieldName(field.name)}
                                value=${values[field.name] ?? ""}
                                onInput=${(event) => setValues({ ...values, [field.name]: event.currentTarget.value })}
                            />`,
                        )}
                        ${
                            form.kind === "sign-in" &&
                            html`<label class="check small"><input type="checkbox" checked=${remember} onChange=${(event) => setRemember(event.currentTarget.checked)} /> ${t("Remember in Secrets for next time")}</label>`
                        }
                        <button type="submit" hidden></button>
                    </form>`
        }
        ${
            canSteer() &&
            html`<div class="approval-actions">
                <button class="button deny" disabled=${busy} onClick=${() => run(() => actions.approve(approval.id, false))}>${form.kind === "do" ? t("Can't") : t("Not now")}</button>
                ${owner && form.saved && html`<button class="button" disabled=${busy} onClick=${() => send({ useSaved: true })}>${t("Use the kept sign-in")}</button>`}
                ${
                    owner &&
                    (form.kind === "do"
                        ? html`<button
                                  class="button"
                                  onClick=${() =>
                                      attempt(async () => {
                                          setBrowserOpen(true);
                                          setPiBrowser(await browserApi("browser/take-over", { on: true }));
                                      })}
                              >
                                  ${t("Open Pi's browser")}
                              </button>
                              <button class="button primary" disabled=${busy} onClick=${() => run(async () => {
                                  if (piBrowserState()?.takenOver) {
                                      setPiBrowser(await browserApi("browser/take-over", { on: false }));
                                  }

                                  await actions.answerBrowserAsk(approval.id, { done: true });
                              })}>${t("Done")}</button>`
                        : html`<button class="button primary" disabled=${busy || !filled} onClick=${() => send({ values, remember })}>${form.kind === "code" ? t("Enter code") : t("Sign in")}</button>`)
                }
            </div>`
        }
    </div>`;
}

/**
 * Pi's question before it tracks a session's work on a project board (the Projects extension's `board_mode`): yes turns
 * board mode on here, no keeps the board out of this session (its menu can turn it on later).
 */
function BoardModeCard({ approval }) {
    const [busy, setBusy] = useState(false);
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    return html`<div class="approval" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="board" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${t("Track this on the board?")}</span>
                <span class="approval-reason"><${Linked} text=${approval.reason} /></span>
            </div>
        </div>
        <div class="muted small">${t("{subject}. Yes turns board mode on for this session; the session menu turns it off.", { subject: approval.subject })}</div>
        ${
            canSteer()
                ? html`<div class="approval-actions">
                      <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Not now")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Yes, use the board")}</button>
                  </div>`
                : html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
        }
    </div>`;
}

/**
 * Pi adds a machine (`machine_add`, PP-139): one card with all Approve does. The address, the key, the host key as scanned
 * now (and whether it is the one Pi read on the machine itself), and the install. The owner's to approve; Deny saves
 * nothing.
 */
function MachineAddCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    // The tools to install once it is connected (PP-177): ticked but the big ones (`optIn`: ffmpeg, HyperFrames), as
    // Settings › Machines offers them.
    const offered = form.tools ?? [];
    const [wanted, setWanted] = useState(() => new Set(offered.filter((tool) => !tool.optIn).map((tool) => tool.id)));
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow, allow ? { tools: [...wanted] } : {})).finally(() => setBusy(false));
    };

    return html`<div class="approval machine-add-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="monitor" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${tx("Add {name} to your machines?", { name: html`<span class="mono">${form.name}</span>` })}</span>
                <span class="approval-reason"><${Linked} text=${approval.reason} /></span>
            </div>
        </div>
        <dl class="machine-add-facts">
            <dt>${t("Address")}</dt>
            <dd class="mono">${form.address}</dd>
            <dt>${t("SSH key")}</dt>
            <dd>
                <span class="mono">${form.key.name}</span>
                ${
                    form.key.new
                        ? html` <span class="muted">${t("new: made when you approve")}</span>`
                        : html` <span class="muted mono small">${form.key.fingerprint}</span>`
                }
            </dd>
            <dt>${t("Host key")}</dt>
            <dd>
                ${form.hostKeys.map((fingerprint) => html`<div class="mono small">${fingerprint}</div>`)}
                ${
                    form.matches === true
                        ? html`<span class="machine-add-match"><${Icon} name="check" size=${12} /> ${t("the one Pi read on the machine itself")}</span>`
                        : html`<span class="muted small">${t("Compare it with the machine's own, if you can.")}</span>`
                }
            </dd>
        </dl>
        ${
            offered.length > 0 &&
            html`<div class="machine-tools-pick">
                <div class="label">${t("Also install there")}</div>
                ${offered.map(
                    (tool) => html`<label class="check machine-tool" key=${tool.id}>
                        <input
                            type="checkbox"
                            checked=${wanted.has(tool.id)}
                            disabled=${busy || me?.role !== "owner"}
                            onChange=${(event) => {
                                const next = new Set(wanted);

                                if (event.currentTarget.checked) {
                                    next.add(tool.id);
                                } else {
                                    next.delete(tool.id);
                                }

                                setWanted(next);
                            }}
                        />
                        <span>
                            <strong>${tool.name}</strong> ${tool.signer ? t("signed by {signer}", { signer: tool.signer.replace(/^CN=/, "") }) : tool.version} <span class="muted small">· ${tool.size}${tool.onlyIfMissing ? ` · ${t("only if the machine has none")}` : ""}${tool.desktop ? ` · ${t("needs a desktop session on Linux")}` : ""}${tool.windowsOnly ? ` · ${t("for Windows only, for now")}` : ""}</span>
                            <div class="muted small">${tool.description}</div>
                        </span>
                    </label>`,
                )}
            </div>`
        }
        <div class="muted small">
            ${t("Approve trusts this host key, installs pi-env there (about 2 MB, in ~/.pi/mobile/tools) and connects. Deny saves nothing.")}
        </div>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("Adding a machine is the owner's: waiting for them.")}</div>`
                : html`<div class="approval-actions">
                      <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Deny")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Approve and connect")}</button>
                  </div>`
        }
    </div>`;
}

/**
 * Pi asks to control a phone (`phone_control`, PP-141): the device, the apps the session may read and touch (and the home
 * screen, to open them), and for how long. The owner's to approve; it starts the session, with a banner and Stop on the
 * phone.
 */
function PhoneControlCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    return html`<div class="approval phone-control-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="phone" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${t("Let Pi use {device} for {n} minutes?", { device: form.deviceName === "This phone" ? t("this phone") : form.deviceName, n: form.minutes })}</span>
                ${approval.reason && html`<span class="approval-reason"><${Linked} text=${approval.reason} /></span>`}
            </div>
        </div>
        <dl class="machine-add-facts">
            <dt>${t("Apps")}</dt>
            <dd>
                ${form.apps.map((app) => html`<div><span>${app.label}</span> <span class="muted mono small">${app.package}</span></div>`)}
                <div class="muted small">${t("and the home screen, to open them")}</div>
                ${
                    form.follow &&
                    html`<div class="phone-control-follow">${t("and the apps these open while Pi works in them (Settings' Battery opening Device care), added as they come")}</div>`
                }
            </dd>
            <dt>${t("For")}</dt>
            <dd>${t("{n} minutes, from when you approve", { n: form.minutes })}</dd>
        </dl>
        <div class="muted small">
            ${t("Pi reads the screen and taps, types and swipes only in these apps. A banner and a notification on the phone show it, with Stop. pi-phone, banking apps, password managers and your Never list stay out.")}
        </div>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("Controlling the phone is the owner's: waiting for them.")}</div>`
                : html`<div class="approval-actions">
                      <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Deny")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Approve and start")}</button>
                  </div>`
        }
    </div>`;
}

/**
 * Pi asks to control a computer (`computer_control`, PP-178): the machine, the apps the session may read and act in (by
 * window title, and name), and the minutes Pi asked for. The owner's to approve; it starts the session, with a window on
 * the machine that says so, with Stop.
 */
function ComputerControlCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    return html`<div class="approval phone-control-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="monitor" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${t("Let Pi use {machine} for {n} minutes?", { machine: form.machineName, n: form.minutes })}</span>
                ${approval.reason && html`<span class="approval-reason"><${Linked} text=${approval.reason} /></span>`}
            </div>
        </div>
        <dl class="machine-add-facts">
            <dt>${t("Machine")}</dt>
            <dd>
                <div><span>${form.machineName}</span></div>
                <div class="muted small">${[form.platform === "linux" ? "Linux" : form.platform, form.ocu && `ocu ${form.ocu}`].filter(Boolean).join(" · ")}</div>
            </dd>
            <dt>${t("Apps")}</dt>
            <dd>
                ${form.apps.map((app) => html`<div><span>${app.label}</span>${app.label !== app.name ? html` <span class="muted mono small">${app.name}</span>` : ""}</div>`)}
                ${
                    form.follow &&
                    html`<div class="phone-control-follow">${t("and the windows these open while Pi works in them (a Save dialog, a settings window), added as they come")}</div>`
                }
            </dd>
            <dt>${t("For")}</dt>
            <dd>
                ${t("{n} minutes, from when you approve", { n: form.minutes })}
                <div class="muted small">${t("as Pi asked; for more, Pi asks again")}</div>
            </dd>
        </dl>
        <div class="muted small">
            ${t("Pi reads these windows and clicks, types and scrolls only in them, never in a password field. A window on the machine shows it, with Stop. pi-phone, banking apps, password managers and your Never list stay out.")}
        </div>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("Controlling a computer is the owner's: waiting for them.")}</div>`
                : html`<div class="approval-actions">
                      <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Deny")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Approve and start")}</button>
                  </div>`
        }
    </div>`;
}

/** A computer sign-in card's field, in the app's own words: never the window's (it could put its own on the card). */
const computerFieldName = (name) => (name === "username" ? t("Username") : name === "password" ? t("Password") : t("Code"));

/**
 * Pi asks the owner to sign in in a window of its computer control session (`computer_sign_in`, PP-183): the username,
 * the password or a code, each straight into the element Pi named through ocu, never into the conversation. A sign-in
 * can be kept in Secrets (Remember) and used from there next time. The owner's to answer; anyone who can steer may say
 * not now.
 */
function ComputerSignInCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [values, setValues] = useState({});
    const [remember, setRemember] = useState(false);
    const [busy, setBusy] = useState(false);
    const owner = me?.role === "owner";
    const run = (work) => {
        setBusy(true);
        attempt(work).finally(() => setBusy(false));
    };
    const filled = form.fields.every((field) => (values[field.name] ?? "") !== "");
    const send = (body) => run(() => actions.answerComputerSignIn(approval.id, body));
    const codeOnly = form.fields.every((field) => field.name === "code");

    return html`<div class="approval computer-sign-in-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="key" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${t("Sign in to {app} on {machine}", { app: form.app.label, machine: form.machineName })}</span>
                <span class="approval-reason">${t("What you type goes into the window on the computer; Pi never sees it.")}</span>
            </div>
        </div>
        ${
            !owner
                ? html`<div class="muted small">${t("Signing in on the computer is the owner's: waiting for them.")}</div>`
                : html`<form
                      class="browser-ask-fields"
                      onSubmit=${(event) => {
                          event.preventDefault();

                          if (filled) {
                              send({ values, remember });
                          }
                      }}
                  >
                      ${form.fields.map(
                          (field) => html`<input
                              type=${field.name === "username" ? "text" : "password"}
                              autocomplete=${field.name === "username" ? "username" : field.name === "password" ? "current-password" : "one-time-code"}
                              inputmode=${field.name === "code" ? "numeric" : undefined}
                              aria-label=${computerFieldName(field.name)}
                              placeholder=${computerFieldName(field.name)}
                              value=${values[field.name] ?? ""}
                              onInput=${(event) => setValues({ ...values, [field.name]: event.currentTarget.value })}
                          />`,
                      )}
                      ${
                          form.secret &&
                          html`<label class="check small"><input type="checkbox" checked=${remember} onChange=${(event) => setRemember(event.currentTarget.checked)} /> ${t("Remember in Secrets for next time")}</label>`
                      }
                      <button type="submit" hidden></button>
                  </form>`
        }
        ${
            canSteer() &&
            html`<div class="approval-actions">
                <button class="button deny" disabled=${busy} onClick=${() => run(() => actions.approve(approval.id, false))}>${t("Not now")}</button>
                ${owner && form.saved && !form.fields.some((field) => field.name === "code") && html`<button class="button" disabled=${busy} onClick=${() => send({ useSaved: true })}>${t("Use the kept sign-in")}</button>`}
                ${owner && html`<button class="button primary" disabled=${busy || !filled} onClick=${() => send({ values, remember })}>${codeOnly ? t("Enter code") : t("Sign in")}</button>`}
            </div>`
        }
    </div>`;
}

/**
 * Pi asks the owner to connect Chrome Remote Desktop on a Windows machine to their Google account (`computer_control
 * setup` with crd: connect, PP-263): Google's steps, the command and a PIN, sent to the server alone, which answers the
 * card once the machine is connected (a failure, such as an expired code, keeps it open with why). The owner's to answer;
 * anyone who can steer may say not now.
 */
function CrdConnectCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const run = (work) => {
        setBusy(true);
        attempt(work).finally(() => setBusy(false));
    };

    return html`<div class="approval crd-connect-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="monitor" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${t("Connect Chrome Remote Desktop on {machine} to your Google account", { machine: form.machineName })}</span>
                ${approval.reason && html`<span class="approval-reason"><${Linked} text=${approval.reason} /></span>`}
            </div>
        </div>
        ${
            me?.role === "owner"
                ? html`<${CrdConnectForm}
                      machineName=${form.machineName}
                      busy=${busy}
                      actionsClass="approval-actions"
                      cancelLabel=${t("Not now")}
                      onCancel=${() => run(() => actions.approve(approval.id, false))}
                      onSubmit=${(values) => run(() => actions.answerCrdConnect(approval.id, values))}
                  />`
                : html`<div class="muted small">${t("Connecting Chrome Remote Desktop is the owner's: waiting for them.")}</div>
                      ${
                          canSteer() &&
                          html`<div class="approval-actions">
                              <button class="button deny" disabled=${busy} onClick=${() => run(() => actions.approve(approval.id, false))}>${t("Not now")}</button>
                          </div>`
                      }`
        }
    </div>`;
}

/** While Pi uses a phone for this session (PP-141): which apps, the minutes left, and Stop. The owner's tabs only. */
function PhoneControlLine({ conversationId }) {
    const [, tick] = useState(0);
    const running = (store.state.phoneControl ?? []).filter((each) => each.conversationId === conversationId || each.session === conversationId);

    useEffect(() => {
        if (running.length === 0) {
            return undefined;
        }

        const timer = setInterval(() => tick((n) => n + 1), 15_000);

        return () => clearInterval(timer);
    }, [running.length]);

    return running.map(
        (each) => html`<div class="phone-control-line" data-part="phone-control-line" key=${each.device}>
            <${Icon} name="phone" size=${14} />
            <span class="phone-control-what">
                ${[
                    t("Using {device}", { device: each.deviceName === "This phone" ? t("this phone") : each.deviceName }),
                    each.apps.map((app) => app.label).join(", "),
                    t("{n} min left", { n: Math.max(0, Math.ceil((fromServer(each.until) - Date.now()) / 60_000)) }),
                ].join(" · ")}
            </span>
            <button class="button small" onClick=${() => attempt(() => api("phone-control/stop", { device: each.device }))}>${t("Stop")}</button>
        </div>`,
    );
}

/**
 * A question for the person Pi works for, from an extension (`host.ask`, ported from pi-pocket 0.22.0): its fields, sent
 * only by that person, and declined by anyone who can steer. What is typed goes to the extension that asked, never to Pi
 * or into the transcript.
 */
function AskCard({ approval }) {
    const { me, users } = store.state;
    const form = approval.form;
    const [values, setValues] = useState(() => Object.fromEntries(form.fields.map((field) => [field.name, ""])));
    const [busy, setBusy] = useState(false);
    const owner = users?.find?.((each) => each.role === "owner")?.id;
    const mine = (approval.requestedBy ?? owner) === me?.id;
    const who = users?.find?.((each) => each.id === approval.requestedBy)?.name;
    const ready = form.fields.every((field) => values[field.name] !== "");
    const run = (work) => {
        setBusy(true);
        attempt(work).finally(() => setBusy(false));
    };
    const send = () => run(() => actions.answerAsk(approval.id, values));
    // The words an extension gives are its own; the two the app chooses when it gives none are the app's.
    const submit = form.submit === "Send" ? t("Send") : form.submit === "Done" ? t("Done") : form.submit;

    return html`<form
        class="approval ask"
        data-part="approval"
        onSubmit=${(event) => {
            event.preventDefault();

            if (mine && ready && !busy) {
                send();
            }
        }}
    >
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="key" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${form.title}</span>
                ${form.text && html`<span class="approval-reason"><${Linked} text=${form.text} /></span>`}
            </div>
        </div>
        ${
            mine
                ? html`${form.fields.map(
                      (field) => html`<label class="ask-field" key=${field.name}>
                          <span>${field.label}</span>
                          <input
                              type=${field.secret ? "password" : "text"}
                              name=${field.name}
                              value=${values[field.name]}
                              placeholder=${field.placeholder ?? ""}
                              autocomplete=${field.autocomplete ?? "off"}
                              autocapitalize="off"
                              spellcheck="false"
                              disabled=${busy}
                              onInput=${(event) => setValues({ ...values, [field.name]: event.currentTarget.value })}
                          />
                      </label>`,
                  )}
                  ${form.fields.length > 0 && html`<div class="muted small">${t("What you type goes to the extension that asked. Pi does not see it.")}</div>`}`
                : html`<div class="muted small">
                      ${who === undefined ? t("Waiting for the person Pi works for to answer.") : t("Waiting for {who} to answer.", { who })}
                  </div>`
        }
        ${
            canSteer() &&
            html`<div class="approval-actions">
                <button type="button" class="button deny" disabled=${busy} onClick=${() => run(() => actions.approve(approval.id, false))}>
                    ${t("Decline")}
                </button>
                ${mine && html`<button type="submit" class="button primary" disabled=${busy || !ready}>${submit}</button>`}
            </div>`
        }
    </form>`;
}

/**
 * Pi installs a drop-in extension (`extension_install`, PP-173): where it comes from, its size and files, what is left out
 * and what it replaces, and the module's first lines, all before Install. The owner's to approve; it lands switched off.
 */
function ExtensionInstallCard({ approval }) {
    const { me } = store.state;
    const form = approval.form;
    const [busy, setBusy] = useState(false);
    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    return html`<div class="approval extension-install-card" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="shield" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${tx("Install the extension {module}?", { module: html`<span class="mono">${form.module}</span>` })}</span>
                <span class="approval-reason">${t("It runs in the app with all it has (secrets included) once you turn it on. It lands switched off.")}</span>
            </div>
        </div>
        <dl class="machine-add-facts">
            <dt>${t("From")}</dt>
            <dd class="mono">${form.path}</dd>
            <dt>${t("Size")}</dt>
            <dd>${t("{n} KB", { n: Math.max(1, Math.round(form.bytes / 1024)) })}</dd>
            <dt>${t("Files")}</dt>
            <dd>${form.files.map((file) => html`<div class="mono small">${file}</div>`)}</dd>
            ${form.leftOut.length > 0 && html`<dt>${t("Left out")}</dt><dd class="mono small">${form.leftOut.join(", ")}</dd>`}
            ${form.replaces.length > 0 && html`<dt>${t("Replaces")}</dt><dd class="mono small">${form.replaces.join(", ")}</dd>`}
        </dl>
        <pre class="cmd">${form.head}</pre>
        ${
            me?.role !== "owner"
                ? html`<div class="muted small">${t("Installing an extension is the owner's: waiting for them.")}</div>`
                : html`<div class="approval-actions">
                      <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>${t("Decline")}</button>
                      <button class="button primary" disabled=${busy} onClick=${() => answer(true)}>${t("Install")}</button>
                  </div>`
        }
    </div>`;
}

/** What someone did with a call that waited for them: an ask (`host.ask`) is answered or declined. */
function decided(decision) {
    if (decision.ask) {
        return decision.allow ? t("Answered by {who}", { who: decision.by }) : t("Declined by {who}", { who: decision.by });
    }

    return decision.allow ? t("Allowed by {who}", { who: decision.by }) : t("Denied by {who}", { who: decision.by });
}

function ApprovalCard({ approval }) {
    const { me, server } = store.state;
    const [busy, setBusy] = useState(false);

    if (approval.form?.type === "ask") {
        return html`<${AskCard} approval=${approval} />`;
    }

    if (approval.form?.type === "extension") {
        return html`<${ExtensionInstallCard} approval=${approval} />`;
    }

    if (approval.form?.type === "phone") {
        return html`<${PhoneControlCard} approval=${approval} />`;
    }

    if (approval.form?.type === "computer") {
        return html`<${ComputerControlCard} approval=${approval} />`;
    }

    if (approval.form?.type === "computer-sign-in") {
        return html`<${ComputerSignInCard} approval=${approval} />`;
    }

    if (approval.form?.type === "crd-connect") {
        return html`<${CrdConnectCard} approval=${approval} />`;
    }

    if (approval.form?.type === "machine") {
        return html`<${MachineAddCard} approval=${approval} />`;
    }

    if (approval.form?.type === "secret") {
        return html`<${SecretRequestCard} approval=${approval} />`;
    }

    if (approval.form?.type === "browser") {
        return html`<${BrowserAskCard} approval=${approval} />`;
    }

    if (approval.form?.type === "interview") {
        return html`<${InterviewCard} approval=${approval} />`;
    }

    if (approval.tool === "board_mode") {
        return html`<${BoardModeCard} approval=${approval} />`;
    }

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    // With approvals that need someone else, a guest cannot allow a call their own message led to (the server checks too).
    const ownCall =
        server?.approvalRule === "others" &&
        me?.role !== "owner" &&
        approval.requestedBy === me?.id;

    return html`<div class="approval" data-part="approval">
        <div class="approval-head">
            <span class="approval-shield" aria-hidden="true"><${Icon} name="shield" size=${16} /></span>
            <div class="approval-title">
                <span class="approval-ask">${tx("Pi asks before this {tool} call", { tool: approval.tool })}</span>
                <span class="approval-reason"><${Linked} text=${approval.reason} /></span>
            </div>
        </div>
        <pre class="cmd">${approval.tool === "bash" && html`<span class="cmd-sign">$ </span>`}${approval.subject}</pre>
        ${
            !canSteer()
                ? html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
                : html`${
                      ownCall &&
                      html`<div class="muted small">
                          ${t("Someone else has to allow this: it came from your message. You can deny it.")}
                      </div>`
                  }
                <div class="approval-actions">
                    <button class="button deny" disabled=${busy} onClick=${() => answer(false)}>
                        ${t("Deny")}
                    </button>
                    ${
                        !ownCall &&
                        html`<button
                            class="button primary"
                            disabled=${busy}
                            onClick=${() => answer(true)}
                        >
                            ${approval.tool === "secret_save" ? t("Run and save") : t("Allow")}
                        </button>`
                    }
                </div>`
        }
    </div>`;
}

// ─── Pi's words ───────────────────────────────────────────────────────────────────────

/** Under Pi's answers: reactions, and ways to talk about the answer with the people here. */
function AnswerActions({ entry }) {
    const { view, me, users, server } = store.state;
    const [picking, setPicking] = useState(false);
    const reactions = view.reactions?.[entry.id] ?? {};
    const pinned = (view.pins ?? []).some((pin) => pin.entryId === entry.id);
    const text = replyText(entry);
    const names = (ids) =>
        ids
            .map((id) =>
                id === me?.id ? "you" : (users.find((user) => user.id === id)?.name ?? "someone"),
            )
            .join(", ");

    const react = (emoji) => {
        setPicking(false);
        attempt(() => actions.react(entry.id, emoji));
    };

    return html`<div class=${`answer-actions ${picking ? "picking" : ""}`} data-part="reply-actions">
        ${Object.entries(reactions).map(
            ([emoji, ids]) =>
                html`<button
                    class=${`reaction ${ids.includes(me?.id) ? "mine" : ""}`}
                    title=${`${emoji} ${names(ids)}`}
                    onClick=${() => react(emoji)}
                >
                    ${emoji} <span>${ids.length}</span>
                </button>`,
        )}
        <span class="reaction-host answer-tool">
            <button
                class="reaction add"
                aria-label=${t("React")}
                title=${t("React")}
                onClick=${() => setPicking(!picking)}
            >
                ☺+
            </button>
            ${
                picking &&
                html`<span class="reaction-picker">
                    ${(server?.reactions ?? []).map(
                        (emoji) => html`<button onClick=${() => react(emoji)}>${emoji}</button>`,
                    )}
                </span>`
            }
        </span>
        <button
            class="answer-tool"
            onClick=${() => discuss(entry.id, plainText(text).replace(/\s+/g, " ").slice(0, 280))}
        >
            ${t("Discuss")}
        </button>
        <button
            class="answer-tool"
            onClick=${() => attempt(() => actions.pin({ entryId: entry.id }))}
        >
            ${pinned ? html`<${Icon} name="pin" size=${12} /> ${t("Pinned")}` : t("Pin")}
        </button>
        <button
            class="answer-tool"
            onClick=${() =>
                copyText(text).then(
                    () => notify("info", t("Copied.")),
                    () => notify("error", t("Could not copy.")),
                )}
        >
            ${t("Copy")}
        </button>
        <button
            class="answer-tool"
            title=${t("Fork, retry")}
            onClick=${() => openSheet({ type: "message", entryId: entry.id })}
        >
            ${t("More")}
        </button>
    </div>`;
}

/** How one of Pi's answers ended, under its last words: a failed request, a stop, or the answer's actions. */
function AnswerEnd({ entry }) {
    // A final answer (not a step between tool calls) with something to say gets reactions and the discuss row.
    const answer = collab() && entry.stopReason !== "toolUse" && entry.blocks.some(says);

    return html`${
        entry.stopReason === "error" &&
        html`<div class="error-box">${entry.error ?? t("The model request failed.")}</div>
            <${LimitSwitch} error=${entry.error} />`
    }
    ${entry.stopReason === "aborted" && html`<div class="muted small">${t("Stopped.")}</div>`}
    ${answer && html`<${AnswerActions} entry=${entry} />`}`;
}

/** A run of Pi's words: plain prose, and how the answer ended when they are its last. */
function Reply({ item, conversationId }) {
    const [fresh] = useState(() => settledFor !== null && settledFor === conversationId);
    const { entry, blocks } = item;

    return html`<div
        class=${`reply ${fresh ? "enter" : ""}`}
        data-part="reply"
        id=${item.anchor ? `entry-${entry.id}` : undefined}
    >
        ${blocks.map(({ block, growing }, index) => {
            // The block still growing changes on every update: caching each version would only push out finished ones.
            return html`<${Markdown}
                key=${index}
                text=${block.text}
                class=${growing ? "streaming" : ""}
                cache=${!growing}
            />`;
        })}
        ${item.end && html`<${AnswerEnd} entry=${entry} />`}
    </div>`;
}

function Divider({ entry }) {
    const [open, setOpen] = useState(false);

    // A session continued from Pi in the terminal: what is above is Pi's, from that session's file.
    if (entry.kind === "fromPi") {
        // A teammate's shared session continued here (Continue in mine, PP-59): its file is named shared-…
        if (String(entry.file ?? "").startsWith("shared-")) {
            return html`<div class="divider"><span>${t("Continued from a session shared with you")}</span></div>`;
        }

        return html`<div class="divider">
            <span>${t("Continued from Pi in the terminal")}</span>
            <div class="muted small mono">${entry.file}</div>
        </div>`;
    }

    if (entry.kind === "reset") {
        return html`<div class="divider">
            <span>${t("New context")}</span>
            ${entry.text && html`<div class="divider-body"><${Markdown} text=${entry.text} /></div>`}
        </div>`;
    }

    return html`<div class="divider">
        <button class="link" onClick=${() => setOpen(!open)}>
            ${t("Context compacted")} ${open ? "▾" : "▸"}
        </button>
        ${open && html`<div class="divider-body"><${Markdown} text=${entry.summary} /></div>`}
    </div>`;
}

function History({ firstId, results, keepPlace, conversationId }) {
    const history = store.state.history;
    const talk = collab();
    // Built again only when the history changes, not on each draw of the transcript.
    const items = useMemo(
        () =>
            history === null ? [] : itemsOf(history.filter(isRow), null, { prefix: "h", talk }),
        [history, talk],
    );

    if (history === null) {
        return html`<div class="divider">
            <button
                class="link"
                onClick=${() =>
                    attempt(async () => {
                        const earlier = await actions.history(firstId);

                        keepPlace();
                        store.set({ history: earlier });
                    })}
            >
                ${t("Show earlier messages")}
            </button>
        </div>`;
    }

    return html`<div class="history">
        <${Items}
            items=${items}
            results=${results}
            slots=${NO_SLOTS}
            approvals=${NO_APPROVALS}
            busy=${false}
            past=${true}
            conversationId=${conversationId}
        />
    </div>`;
}

/** How a command someone ran ended, when that is worth saying. */
const SHELL_ENDS = {
    timeout: () => t("timed out"),
    failed: () => t("could not run"),
    interrupted: () => t("cut off by a restart"),
    stopped: () => t("stopped"),
};

/** How many of a command's last lines show before "Show all". */
const SHELL_LINES = 12;

/**
 * What a command printed, as a card: a `!` command's, or an extension command's card. A long output shows its last lines
 * until opened, and one the server cut short loads in full on a tap.
 */
function OutputCard({ entry, command, meta, failed = false, longCommand = false, copy = false }) {
    const [open, setOpen] = useState(false);
    const [full, setFull] = useState(null);
    const output = (full ?? entry.output).replace(/\s+$/, "");
    const lines = output.split("\n");
    const long = lines.length > SHELL_LINES;
    const whole = async () =>
        full ?? (entry.truncated ? (await actions.fullEntry(entry.id)).output : entry.output);

    return html`<div class="shell-row" id=${`entry-${entry.id}`}>
        <div class=${`shell-card ${failed ? "failed" : ""} ${open ? "open" : ""}`}>
            <div class="shell-head">
                <span class="mono shell-command">${command}</span>
                <span class="muted small">${meta}</span>
            </div>
            ${
                output !== "" &&
                html`<pre class="output">
                    ${long && !open ? `…\n${lines.slice(-SHELL_LINES).join("\n")}` : output}
                </pre>`
            }
            ${
                (long || longCommand) &&
                html`<button class="link small" onClick=${() => setOpen(!open)}>
                    ${open ? t("Show less") : long ? t("Show all {n} lines", { n: lines.length }) : t("Show all")}
                </button>`
            }
            ${
                entry.truncated &&
                full === null &&
                html`<button
                    class="link small"
                    onClick=${() =>
                        attempt(async () => {
                            setFull(await whole());
                            setOpen(true);
                        })}
                >
                    ${t("Load everything")}
                </button>`
            }
            ${
                copy &&
                html`<button
                    class="link small"
                    onClick=${() =>
                        attempt(async () => {
                            const text = await whole();

                            setFull(text);
                            await copyText(text);
                            notify("info", t("Copied the output."));
                        })}
                >
                    ${t("Copy output")}
                </button>`
            }
        </div>
    </div>`;
}

/** An extension command's card: text for the people here, never in Pi's context. */
function CommandEntry({ entry }) {
    return html`<${OutputCard}
        entry=${entry}
        command=${`/${entry.command}`}
        meta=${`${entry.name} · ${t("not shown to Pi")}${entry.clipped ? ` · ${t("only the end is kept")}` : ""}`}
        copy=${true}
    />`;
}

/** A command someone ran with `!` (or `!!`, which Pi does not see): what it printed, and how it ended. */
function ShellEntry({ entry }) {
    // A long command (a paste in it, say) shows its first lines until opened.
    const longCommand = entry.command.split("\n").length > 3 || entry.command.length > 240;
    const end =
        entry.status === "done"
            ? entry.code === 0
                ? ""
                : t("exit {code}", { code: entry.code })
            : SHELL_ENDS[entry.status]?.();

    return html`<${OutputCard}
        entry=${entry}
        command=${`$ ${entry.command}`}
        meta=${`${entry.name}${end ? ` · ${end}` : ""}${entry.context ? "" : ` · ${t("not shown to Pi")}`}`}
        failed=${Boolean(end)}
        longCommand=${longCommand}
    />`;
}

/**
 * What was said in a voice call and did not go to Pi as a message (PP-188): the owner's words and the voice's, as quiet
 * rows. Talk in "Chat only" goes to Pi with the next message, which the row says.
 */
function VoiceEntry({ entry }) {
    return html`<div class="voice-entry" id=${`entry-${entry.id}`} data-part="voice-entry">
        ${entry.turns.map(
            (turn) => html`<div class="voice-line" data-part="voice-line">
                <${Icon} name=${turn.speaker === "you" ? "mic" : "speaker"} size=${12} />
                <span><b>${turn.speaker === "you" ? t("You") : t("Voice")}</b> · ${turn.text}</span>
            </div>`,
        )}
        ${entry.chat && html`<div class="voice-line voice-note">${t("Voice chat: Pi reads it with your next message.")}</div>`}
    </div>`;
}

/** Something a person did that Pi was told about, such as undoing a file. */
function NoteEntry({ entry }) {
    return html`<div class="note-line" id=${`entry-${entry.id}`}>
        ${entry.name} ${entry.text}. <span class="muted">${t("Pi was told.")}</span>
    </div>`;
}

/** How long a `!` command's row may wait for its entry: past the server's limit for a command, something went wrong. */
const PENDING_MS = 11 * 60_000;

/** How long a scroller may glide on after a finger lets go of it, at most. */
const GLIDE_MS = 3000;

/** How long after a tap or a key in the conversation what grows there is what the reader opened, not new rows. */
const OPENED_MS = 1000;

/** A touch screen, where scrollers glide on after a flick and their scroll bars take no room. */
const COARSE = matchMedia("(pointer: coarse)");

/**
 * Straight to the bottom of `element`. On an iPhone a scroller can still be gliding from a flick when the way to the
 * bottom is tapped, and WebKit keeps the glide's place over one set from script: the screen goes blank, and the next
 * touch carries on from where it was. Not scrolling for two frames ends the glide, so the jump holds. (Elsewhere a
 * scroll bar that went for a moment would shift the page.)
 */
function toBottom(element) {
    element.scrollTop = element.scrollHeight;

    if (!COARSE.matches) {
        return;
    }

    element.style.overflowY = "hidden";
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            element.style.overflowY = "";
            element.scrollTop = element.scrollHeight;
        }),
    );
}

/** `!` commands this tab started that have no entry yet: still running, or waiting for Pi to finish its turn. */
function PendingShells({ conversationId, rows }) {
    const pending = store.state.pendingShells.filter(
        (each) =>
            each.conversationId === conversationId &&
            Date.now() - each.at < PENDING_MS &&
            !rows.some((row) => row.kind === "shell" && row.taskId === each.taskId),
    );

    return pending.map(
        (each) => html`<div class="shell-row pending" key=${each.taskId}>
            <div class="shell-card">
                <div class="shell-head">
                    <span class="mono shell-command">$ ${each.command}</span>
                    <span class="muted small"><${Spinner} /> ${t("running")}</span>
                    <button
                        class="link small"
                        onClick=${() => attempt(() => actions.stopShell(each.taskId))}
                    >
                        ${t("Stop")}
                    </button>
                </div>
            </div>
        </div>`,
    );
}

function EntryView({ entry }) {
    const { view, users } = store.state;

    if (entry.kind === "shell") {
        return html`<${ShellEntry} entry=${entry} />`;
    }

    if (entry.kind === "command") {
        return html`<${CommandEntry} entry=${entry} />`;
    }

    if (entry.kind === "note") {
        return html`<${NoteEntry} entry=${entry} />`;
    }

    if (entry.kind === "voice") {
        return html`<${VoiceEntry} entry=${entry} />`;
    }

    if (entry.kind === "user") {
        return html`<${UserEntry} entry=${entry} view=${view} users=${users} />`;
    }

    if (entry.kind === "compaction" || entry.kind === "reset" || entry.kind === "fromPi") {
        return html`<${Divider} entry=${entry} />`;
    }

    return null;
}

const NO_SLOTS = new Map();

const NO_APPROVALS = [];

/** `agentsKey` for each list of subagents the server sent: every report and subagent call asks, on every draw. */
const agentsKeys = new WeakMap();
const NO_AGENTS = [];

/** The subagents as their rows and lines show them: who, where, and how they stand. */
function agentsKey(view) {
    const agents = view.subagents ?? NO_AGENTS;

    if (!agentsKeys.has(agents)) {
        agentsKeys.set(
            agents,
            agents
                .map(
                    (agent) =>
                        `${agent.name}:${agent.conversationId}:${stateOf(agent)}:${agent.askedAt ?? ""}:${agent.answeredAt ?? ""}`,
                )
                .join(),
        );
    }

    return agentsKeys.get(agents);
}

/**
 * Everything a row shows besides its entry, as values that compare with Object.is. Each update from the server builds
 * new objects for the whole view, so this picks out the parts one row uses: a row whose parts did not change skips
 * rendering, and a long thread stays cheap while Pi streams into its newest message.
 */
function rowDeps(entry) {
    const { view, users, me, server } = store.state;
    const deps = [entry, users, me, server, view.conversation?.id, view.conversation?.kind];

    if (entry.kind === "user") {
        deps.push(view.authors?.[entry.id]);

        if (entry.text.startsWith("[subagent ")) {
            deps.push(agentsKey(view));
        }
    }

    return deps;
}

/** What a tool call's line shows besides the call: its result, its live slot, who decided on it, what it made. */
function callDeps(block, results, slots, approvals) {
    const { view } = store.state;
    const slot = slots.get(block.id);
    const decision = decisionOf(view.decisions, block, results.get(block.id));
    const deps = [
        results.get(block.id),
        slot === undefined ? "" : JSON.stringify(slot),
        decision === undefined ? "" : JSON.stringify(decision),
        // How extensions describe their tools' calls (`pocket.toolCall`).
        describersRevision(),
    ];

    if (slot?.taskId !== undefined) {
        deps.push(approvals.find((each) => each.taskId === slot.taskId)?.id);
    }

    if (block.name === "artifact") {
        deps.push((view.artifacts ?? []).map((each) => `${each.id}:${each.type}`).join());
    }

    if (block.name === "subagent") {
        deps.push(agentsKey(view));
    }

    return deps;
}

/** What a run of Pi's words shows besides its text: the answer's reactions and pin, and who is looking. */
function replyDeps(item) {
    const { view, users, me, server } = store.state;
    const { entry } = item;
    const reactions = view.reactions?.[entry.id];

    return [
        entry,
        item.blocks.length,
        item.end,
        item.anchor,
        users,
        me,
        server,
        view.conversation?.id,
        reactions === undefined ? "" : JSON.stringify(reactions),
        (view.pins ?? []).some((pin) => pin.entryId === entry.id),
    ];
}

/** One item of the transcript, rendered again only when its `deps` change. Its cards keep their open state. */
class Memo extends Component {
    shouldComponentUpdate(next) {
        const before = this.props.deps;
        const after = next.deps;

        return (
            before.length !== after.length ||
            before.some((value, index) => !Object.is(value, after[index]))
        );
    }

    render({ children }) {
        return children;
    }
}

/** The answer being written, as an entry: the same object for as long as its blocks stay the same. */
const partials = new WeakMap();

function partialEntry(blocks) {
    if (blocks.length === 0) {
        return null;
    }

    if (!partials.has(blocks)) {
        partials.set(blocks, { kind: "assistant", blocks });
    }

    return partials.get(blocks);
}

/**
 * The transcript's items, each rendered again only when what it shows changed. A group is live while one of its calls
 * works or waits, or while it is the last thing in a run; groups after the last person's message are the newest turn.
 */
function Items({ items, results, slots, approvals, busy, past = false, conversationId }) {
    let lastMessage = -1;

    items.forEach((item, index) => {
        if (item.type === "row" && item.entry.kind === "user") {
            lastMessage = index;
        }
    });

    return items.flatMap((item, index) => {
        if (item.type === "row") {
            return html`<${Memo} key=${item.key} deps=${rowDeps(item.entry)}>
                <${EntryView} entry=${item.entry} />
            <//>`;
        }

        // An answer with nothing to show (blank words): only where a jump to it lands.
        if (item.type === "mark") {
            return html`<span
                key=${item.key}
                class="entry-anchor entry-mark"
                id=${`entry-${item.entry.id}`}
            ></span>`;
        }

        if (item.type === "reply") {
            return html`<${Memo} key=${item.key} deps=${replyDeps(item)}>
                <${Reply} item=${item} conversationId=${conversationId} />
            <//>`;
        }

        const live =
            !past &&
            (item.steps.some((step) => stepLive(step, results, slots, approvals, busy)) ||
                (busy && index === items.length - 1));
        const newest = !past && index > lastMessage;
        // When what came before it was stored: a group still streaming began about then, also before a reload.
        const after = items[index - 1]?.entry?.at;
        const deps = [
            item.steps.length,
            item.before.length,
            item.before[0]?.block,
            item.before.at(-1)?.block,
            item.anchors.join(),
            live,
            newest,
            busy,
            conversationId,
            after,
            prefs().showThinking === true,
        ];

        // The calls before the rows shown count in the group's line: their results, for its time.
        for (const step of item.before) {
            if (step.block.type === "toolCall") {
                deps.push(results.get(step.block.id));
            }
        }

        for (const step of item.steps) {
            deps.push(step.block, step.entry, step.streaming, step.canRun);

            if (step.block.type === "toolCall") {
                deps.push(...callDeps(step.block, results, slots, approvals));
            }
        }

        const group = html`<${Memo} key=${item.key} deps=${deps}>
            <${ActivityGroup}
                item=${item}
                live=${live}
                newest=${newest}
                after=${after}
                busy=${busy}
                results=${results}
                slots=${slots}
                approvals=${approvals}
                conversationId=${conversationId}
            />
        <//>`;
        const lastCall = item.steps.findLast((step) => step.block.type === "toolCall");

        // Stopped in a call, no answer follows to say so: the run ends here, as a stopped answer does.
        if (
            past ||
            busy ||
            index !== items.length - 1 ||
            !STOPPED.test(results.get(lastCall?.block.id)?.text ?? "")
        ) {
            return group;
        }

        return [
            group,
            html`<div key=${`${item.key}:stopped`} class="reply" data-part="reply">
                <div class="muted small">${t("Stopped.")}</div>
            </div>`,
        ];
    });
}

/** When the runs this tab saw started, per conversation: the newest message then, and the time. */
const runsSeen = new Map();

/**
 * When the running work started: when the newest message was sent, if this run is its answer; otherwise when this tab
 * first saw it run (a retry, or a run this tab opened in the middle of). A steer joins the run on the clock; a message
 * queued for after a run starts the clock again, once that run gave its answer.
 */
function runStart(conversationId, entries, busy) {
    if (!busy) {
        runsSeen.delete(conversationId);

        return undefined;
    }

    const at = entries.findLastIndex((entry) => entry.kind === "user");
    const newest = entries[at];
    const finished = (from, to) =>
        entries
            .slice(from, to)
            .some((entry) => entry.kind === "assistant" && entry.stopReason !== "toolUse");

    const begin = () => {
        // Pi answered it already (stopped, failed, or done): this run is not that message's.
        const sent =
            newest?.at === undefined || finished(at + 1)
                ? undefined
                : Math.min(Date.now(), fromServer(newest.at));

        return { message: newest?.id, at: sent ?? Date.now() };
    };

    let seen = runsSeen.get(conversationId);

    if (seen === undefined) {
        seen = begin();
    } else if (seen.message !== newest?.id) {
        const before = entries.findIndex((entry) => entry.id === seen.message);

        seen = finished(before + 1, at) ? begin() : { ...seen, message: newest?.id };
    }

    keep(runsSeen, conversationId, seen);

    return seen.at;
}

/** Whether this person can answer one of the approvals waiting: one who can steer, and for a call not of their own asking where that needs someone else. */
function canAnswer(approvals) {
    const { me, server, users } = store.state;
    const owner = users?.find?.((each) => each.role === "owner")?.id;

    return (
        canSteer() &&
        approvals.some((approval) =>
            // An ask (`host.ask`) is for the person Pi works for, or the owner when nobody is known.
            approval.form?.type === "ask"
                ? (approval.requestedBy ?? owner) === me?.id
                : !(server?.approvalRule === "others" && me?.role !== "owner" && approval.requestedBy === me?.id),
        )
    );
}

/**
 * The sessions whose live thinking is folded, in this tab. With Show thinking on, the thought shows until folded, and a
 * fold holds from one run to the next, and over a reload.
 */
const THINKING_FOLDED_KEY = "pocket.thinkingFolded";
const thinkingFolded = new Set(
    (() => {
        try {
            return JSON.parse(sessionStorage.getItem(THINKING_FOLDED_KEY) ?? "[]");
        } catch {
            return [];
        }
    })(),
);

/**
 * The active response is authoritative, even before it shares any thinking: never pass an old thought off as the new
 * one. While tools work, use only the latest response in this turn, even if it shared no thinking. Keys follow
 * responses and block positions, not text prefixes: two thoughts may start with the same words.
 */
function newestThought(generation, entries) {
    if (generation !== undefined) {
        const blocks = generation.message?.blocks ?? [];
        const index = blocks.findLastIndex((block) => block.type === "thinking");

        if (index === -1) {
            return null;
        }

        const previous = entries.findLast((entry) => entry.kind === "assistant")?.id;

        return {
            block: blocks[index],
            key: `live:${previous}:${generation.attempt}:${index}`,
            handoff: `${previous}:${index}`,
            writing: true,
            streaming: index === blocks.length - 1,
        };
    }

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];

        if (entry.kind === "user") {
            break;
        }

        if (entry.kind !== "assistant") {
            continue;
        }

        const at = entry.blocks.findLastIndex((block) => block.type === "thinking");
        const previous = entries.findLast(
            (each, before) => before < index && each.kind === "assistant",
        )?.id;

        return at === -1
            ? null
            : {
                  block: entry.blocks[at],
                  key: `entry:${entry.id}:${at}`,
                  handoff: `${previous}:${at}`,
                  writing: false,
                  streaming: false,
              };
    }

    return null;
}

/**
 * A quiet reading area above the live line, separate from the timeline's Thought steps. Follow new words until the
 * reader scrolls up; follow again for a new thought, but not when the current response is saved for the tool phase.
 * Mounted only when open, and memoized away from the live timer: no selection, text diff, or layout work while hidden.
 */
function LiveThought({ generation, entries, id }) {
    const box = useRef(null);
    const follow = useRef(true);
    const previous = useRef(null);
    const thought = newestThought(generation, entries);
    const text = thought?.block.text ?? "";
    // A coalesced update can skip whole responses. Only the same response/block keeps the reader's scroll.
    const handedOff =
        previous.current?.writing === true &&
        thought?.writing === false &&
        previous.current.handoff === thought.handoff;

    if (thought?.key !== previous.current?.key && !handedOff) {
        follow.current = true;
    }

    previous.current = thought;

    useLayoutEffect(() => {
        if (follow.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [text, thought?.key]);

    const onScroll = () => {
        const element = box.current;

        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
    };

    const empty = text === "";
    const streaming = thought?.streaming && !empty;
    const label = empty ? t("Thinking") : thought.writing ? t("Current thought") : t("Latest thought");
    const shown = !empty
        ? text
        : thought?.block.redacted
          ? t("The model has hidden its thinking.")
          : generation !== undefined && generation.message === undefined
            ? t("Waiting for thinking text…")
            : t("No thinking text shared for this response.");

    return html`<section class="live-thought" id=${id} aria-label=${t("Pi's thinking")}>
        <div class="live-thought-label">${label}</div>
        <div
            class=${`live-thought-text ${empty ? "is-empty" : ""} ${streaming ? "streaming" : ""}`}
            ref=${box}
            onScroll=${onScroll}
            tabindex="0"
            role="region"
            aria-label=${label}
        >${shown}</div>
    </section>`;
}

/**
 * The end of the live turn, in one line: what Pi does (thinks, works, waits for an approval, retries a failed request,
 * compacts its context), for how long, and how to stop it. Screen readers hear what it does when that changes, not the
 * seconds counting. With Appearance → Show thinking on, Pi's newest thought shows above the line, and a chevron before
 * the line's dot folds it; folded, nothing of the thought is drawn or looked for.
 */
function LiveLine({ live, approvals, start, entries, conversationId }) {
    const [, tick] = useState(0);
    const line = useRef(null);
    /** Where the line was on screen as the thought above it opened or closed, to keep it there. */
    const was = useRef(null);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);

    const thinking = prefs().showThinking === true;
    const open = thinking && !thinkingFolded.has(conversationId);

    // Only as the thought opens or closes: not on the line's every tick.
    useLayoutEffect(() => {
        if (was.current === null) {
            return;
        }

        line.current.closest(".scroller").scrollTop +=
            line.current.getBoundingClientRect().top - was.current;
        was.current = null;
    }, [open]);

    const fold = () => {
        was.current = line.current.getBoundingClientRect().top;

        if (open) {
            thinkingFolded.add(conversationId);
        } else {
            thinkingFolded.delete(conversationId);
        }

        try {
            sessionStorage.setItem(THINKING_FOLDED_KEY, JSON.stringify([...thinkingFolded]));
        } catch {
            // Storage is full or off: the fold still holds in this page.
        }

        tick((n) => n + 1);
    };

    const partial = live.generation?.message?.blocks ?? [];
    const retry = live.generation?.retry;
    const working = (live.tools ?? []).some((slot) => slot.status !== "done");
    const waiting = approvals.length > 0;
    const seconds = retry ? Math.ceil((fromServer(retry.at) - Date.now()) / 1000) : 0;
    // Its request waits for the provider's limit to clear (PP-135): the line says whose, and when it tries again.
    const limit = waiting ? undefined : live.limit;
    let state;

    if (waiting) {
        // Questions from extensions (`host.ask`) wait for an answer, not an approval.
        const asks = approvals.every((approval) => approval.form?.type === "ask");

        state = canAnswer(approvals)
            ? asks
                ? t("Waiting for your answer")
                : t("Waiting for your approval")
            : asks
              ? t("Waiting for an answer")
              : t("Waiting for approval");
    } else if (limit) {
        state = limitWords(limit);
    } else if (retry) {
        state = t("Retrying");
    } else if ((live.compactions ?? []).length > 0) {
        state = t("Compacting context");
    } else if (working || (partial.length > 0 && partial.at(-1).type !== "thinking")) {
        state = t("Working");
    } else {
        state = t("Thinking");
    }

    const thoughtId = `live-thought-${conversationId}`;

    return html`${
        open &&
        html`<${Memo} deps=${[live.generation, entries, conversationId]}>
            <${LiveThought} generation=${live.generation} entries=${entries} id=${thoughtId} />
        <//>`
    }
        <div class=${`live-line ${waiting ? "waiting" : ""} ${limit ? "limited" : ""}`} data-part="live-line" ref=${line}>
        ${
            thinking &&
            html`<button
                class=${`live-fold ${open ? "open" : ""}`}
                aria-expanded=${open}
                aria-controls=${thoughtId}
                aria-label=${open ? t("Hide Pi's thinking") : t("Show Pi's thinking")}
                title=${open ? t("Hide Pi's thinking") : t("Show Pi's thinking")}
                onClick=${fold}
            ><${Icon} name="chevron" size=${14} class="chev" /></button>`
        }
        <span class="live-dot" data-part="live-mark" aria-hidden="true"></span>
        <span class="live-state" role="status">
            ${state}${retry && !waiting && seconds > 0 && html`<span aria-hidden="true"> ${t("in {n}s", { n: seconds })}</span>`}
        </span>
        ${
            limit &&
            html`<span class="live-limit" data-part="live-limit">
                ${limit.probing ? t("trying now") : t("next try in {time}", { time: span(fromServer(limit.until) - Date.now()) })}${
                    limit.resetAt !== undefined && ` · ${t("resets {time}", { time: clock(limit.resetAt) })}`
                }
            </span>`
        }
        ${start !== undefined && !limit && html`<span class="live-time" aria-hidden="true">${span(Date.now() - start)}</span>`}
        ${
            limit &&
            canSteer() &&
            html`<span class="live-acts">
                ${
                    !limit.probing &&
                    html`<button
                        class="live-retry"
                        data-part="live-retry"
                        title=${t("Send the request now. Stop ends the wait.")}
                        onClick=${() =>
                            attempt(async () => {
                                // The gate takes one try each 30 seconds: a press it ignores says so.
                                if ((await actions.retryLimit(conversationId))?.ok === false) {
                                    notify("info", t("Already trying: wait a moment."));
                                }
                            })}
                    >
                        ${t("Retry now")}
                    </button>`
                }
                <button class="live-retry stop" data-part="live-stop" title=${t("Stop the run")} onClick=${() => attempt(() => actions.abort())}>
                    ${t("Stop")}
                </button>
            </span>`
        }
        ${
            retry &&
            !waiting &&
            !limit &&
            html`<span
                class="live-why"
                title=${t("Attempt {n}, after: {error}", { n: live.generation.attempt + 1, error: retry.error })}
            >
                ${retry.error}
            </span>`
        }
        ${
            live.busy &&
            canSteer() &&
            !COARSE.matches &&
            !limit &&
            html`<span class="live-esc" title=${t("Press Esc twice")}>${t("Esc stops")}</span>`
        }
    </div>`;
}

/** What a run waits for, in words: "Waiting for Anthropic · Work's 5-hour limit". */
function limitWords(limit) {
    const provider = limit.providerName;

    if (limit.window) {
        return t("Waiting for {provider}'s {window} limit", { provider, window: windowName(limit.window) });
    }

    if (limit.scope === "account") {
        return t("Waiting for {provider}'s usage limit", { provider });
    }

    return limit.overloaded ? t("Waiting: {provider} is overloaded", { provider }) : t("Waiting for {provider}'s rate limit", { provider });
}

/**
 * The account card of a wait (PP-135): this account hit a plan window's limit, and another account of the same provider
 * has room. Wait keeps waiting and puts the card away; Move sends the waiting request through the other account, which
 * the session (or the subagent) then uses. Until it is answered, the run waits as it would without it.
 */
function LimitOfferCard({ offer }) {
    const [busy, setBusy] = useState(false);
    const [, tick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 30_000);

        return () => clearInterval(timer);
    }, []);

    const resets = clock(offer.resetAt);
    // A team server's shared account says so: moving there spends the team's subscription.
    const nameOf = (account) => (account.team ? t("{name} (team)", { name: account.name }) : account.name);
    const answer = (choice, to) => {
        setBusy(true);
        attempt(() => actions.answerLimit(offer.conversationId, choice, to)).finally(() => setBusy(false));
    };
    const steer = canSteer();
    // The account the person picks in the dropdown: the first listed (their own emptiest) until they pick another, and
    // again when the one picked is no longer listed (the card was made again).
    const [picked, pick] = useState(undefined);
    const chosen = offer.accounts.find((account) => account.to === picked) ?? offer.accounts[0];

    return html`<div class="limit-card" data-part="limit-card">
        <div class="limit-card-head">
            <span class="state-mark limited" aria-hidden="true"></span>
            <div class="limit-card-text">
                ${offer.subagent && html`<span class="limit-card-who">${t("Subagent {name}", { name: offer.subagent })}</span>`}
                <span>
                    ${
                        offer.window
                            ? t("{account} hit its {window} limit.", { account: offer.providerName, window: windowName(offer.window) })
                            : t("{account} hit its usage limit.", { account: offer.providerName })
                    }
                    ${" "}${t("It resets at {time} (in {left}).", { time: resets, left: span(fromServer(offer.resetAt) - Date.now()) })}
                </span>
                <span class="muted">${t("Accounts with room:")}</span>
            </div>
        </div>
        <div class="limit-card-move" data-to=${chosen.to}>
            <${Choice}
                value=${chosen.to}
                label=${t("Account to move to")}
                disabled=${!steer || busy}
                options=${offer.accounts.map((account) => ({
                    value: account.to,
                    label: nameOf(account),
                    detail: t("{n}% of {window} used", { n: account.used, window: windowName(account.window) }),
                }))}
                onChange=${pick}
            />
            ${
                steer &&
                html`<button
                    class="button primary"
                    disabled=${busy}
                    aria-label=${t("Move to {account}", { account: nameOf(chosen) })}
                    onClick=${() => answer("move", chosen.to)}
                >
                    ${t("Move")}
                </button>`
            }
        </div>
        ${
            steer
                ? html`<div class="limit-card-actions">
                      <button class="button" disabled=${busy} onClick=${() => answer("wait")}>${t("Wait until {time}", { time: resets })}</button>
                  </div>`
                : html`<div class="muted small">${t("Waiting for someone who can steer to answer.")}</div>`
        }
    </div>`;
}

/**
 * Which rows to render: from the row `store.state.transcriptFrom` names down. Older rows wait behind "Show earlier
 * messages", so opening a long session and streaming into it stay fast on a phone. Without that row (none chosen yet,
 * or gone after a compaction), the newest `TRANSCRIPT_ROWS`.
 */
function windowStart(rows, from) {
    const index = from === null ? -1 : rows.findIndex((row) => row.id === from);

    return index === -1 ? Math.max(0, rows.length - TRANSCRIPT_ROWS) : index;
}

export function Transcript() {
    const { view, missing, history, transcriptFrom } = store.state;
    const scroller = useRef(null);
    /** The column of rows in the scroller, whose growth keeps it at the bottom (below). */
    const column = useRef(null);
    const stick = useRef(true);
    /** A jump to a message is under way: the reader has not scrolled or tapped since. */
    const jumping = useRef(false);
    /** Distance from the bottom to restore after rows are added above, so the reader stays in place. */
    const keep = useRef(null);
    const counted = useRef(0);
    const [showJump, setShowJump] = useState(false);
    // Opened by a route on a phone, the scroller slides in with it: the column does not rise in as well, unless it comes
    // after the slide (a slow connection). Chosen as the column first draws, so a draw after does not start it.
    const entrance = useRef(null);

    if (entrance.current === null && view.conversation && !missing) {
        entrance.current = routeSliding() ? "" : "rising";
    }

    // Keep the snapshot's rows stable across unrelated UI updates, including scrolling the thought reading area.
    const entries = useMemo(
        () => view.order.map((id) => view.entries.get(id)).filter(Boolean),
        [view.order, view.entries],
    );
    // Built again only when the entries change: the app draws for every change to the store, and a streamed answer's
    // updates bring no new entries (`mergeView`).
    const rows = useMemo(() => entries.filter(isRow), [entries]);
    const start = useMemo(() => windowStart(rows, transcriptFrom), [rows, transcriptFrom]);
    const talk = collab();
    const from = useMemo(() => rowsBefore(rows, start, talk), [rows, start, talk]);
    const partial = partialEntry(view.live.generation?.message?.blocks ?? []);
    const items = useMemo(
        () => itemsOf(rows.slice(start), partial, { from, talk }),
        [rows, start, partial, from, talk],
    );
    const results = useMemo(() => {
        const map = new Map();

        for (const entry of [...(history ?? []), ...entries]) {
            if (entry.kind === "toolResult") {
                map.set(entry.callId, entry);
            }
        }

        return map;
    }, [history, entries]);
    const slots = useMemo(
        () => new Map((view.live.tools ?? []).map((slot) => [slot.callId, slot])),
        [view.live.tools],
    );

    // After a draw that can change the rows, not after every change to the store (each draws the app): to the bottom, or
    // back to where the reader was, before the draw shows. What grows between such draws is the ResizeObserver's below.
    useLayoutEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        const grew = rows.length > counted.current;
        const newest = rows.at(-1);

        // A message of your own just sent: the reader goes down to it, from wherever they had scrolled to.
        if (
            grew &&
            counted.current > 0 &&
            newest?.kind === "user" &&
            view.authors?.[newest.id] === store.state.me?.id &&
            !stick.current
        ) {
            stick.current = true;
            keep.current = null;
            setShowJump(false);
        }

        if (keep.current !== null) {
            element.scrollTop = element.scrollHeight - keep.current;
            keep.current = null;
        } else if (stick.current) {
            element.scrollTop = element.scrollHeight;
        }

        counted.current = rows.length;

        if (rows.length === 0) {
            return;
        }

        // Fix the first row shown, so rows arriving below never push the ones being read off the top: noted without a
        // draw, as this draw began there already ("Show earlier messages" reads it). While the reader follows along at
        // the bottom, drop the oldest once there are twice as many as a fresh open shows.
        if (rows[start].id !== transcriptFrom) {
            store.note({ transcriptFrom: rows[start].id });
        } else if (grew && stick.current && rows.length - start > 2 * TRANSCRIPT_ROWS) {
            store.set({ transcriptFrom: rows[rows.length - TRANSCRIPT_ROWS].id });
        }
    }, [view, history, start]);

    // Once the rows a session opens with are on screen, rows that mount later are new and animate in.
    const conversationId = view.conversation?.id;
    const hasRows = rows.length > 0;

    useEffect(() => {
        settledFor = null;

        if (conversationId === undefined) {
            return;
        }

        const timer = setTimeout(() => (settledFor = conversationId), hasRows ? 350 : 0);

        return () => clearTimeout(timer);
    }, [conversationId, hasRows]);

    // The conversation gets shorter or taller as what is above the message box changes (the queue, the subagents' list,
    // a message box that grows), and its rows grow between draws (a card that draws late, a font that loads, a line
    // under a reply): stay at the bottom if we were there, before the change shows.
    useEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        // Not while a finger moves it, or it glides after one: where it goes is the person's, and on an iPhone a scroll
        // set from script mid-glide does not hold (see `toBottom`).
        let touching = false;
        // Never yet: the page's clock starts at 0 when it loads, so 0 would read as a finger let go just now.
        let released = -Infinity;
        let moved = -Infinity;

        const down = () => {
            touching = true;
        };

        const up = () => {
            touching = false;
            released = performance.now();
        };

        const scrolled = () => {
            moved = performance.now();
        };

        const gliding = () =>
            touching ||
            (performance.now() - released < GLIDE_MS && performance.now() - moved < 100);
        // Nor what a tap or a key there opened (a group, a step): it unrolls in place, where the reader looks. The next
        // draw of new rows takes them down again.
        let pressed = -Infinity;

        const press = () => {
            pressed = performance.now();
        };

        const opened = (changes) =>
            performance.now() - pressed < OPENED_MS &&
            changes.every((change) => change.target !== element);
        const observer = new ResizeObserver((changes) => {
            if (stick.current && !gliding() && !opened(changes)) {
                element.scrollTop = element.scrollHeight;
            }
        });

        element.addEventListener("touchstart", down, { passive: true });
        element.addEventListener("touchend", up, { passive: true });
        element.addEventListener("touchcancel", up, { passive: true });
        element.addEventListener("scroll", scrolled, { passive: true });
        element.addEventListener("pointerdown", press, { capture: true, passive: true });
        element.addEventListener("keydown", press, { capture: true, passive: true });
        observer.observe(element);

        if (column.current) {
            observer.observe(column.current);
        }

        return () => {
            observer.disconnect();
            element.removeEventListener("touchstart", down);
            element.removeEventListener("touchend", up);
            element.removeEventListener("touchcancel", up);
            element.removeEventListener("scroll", scrolled);
            element.removeEventListener("pointerdown", press, { capture: true });
            element.removeEventListener("keydown", press, { capture: true });
        };
    }, [view.conversation?.id]);

    // A jump to a message (`jumpToEntry`) leaves the bottom, until the reader scrolls or taps: its smooth scroll starts
    // near the bottom, where `onScroll` would follow along again, and what grows next (the earlier rows drawn for it,
    // which the ResizeObserver above sees) would take them back down.
    useEffect(() => {
        const away = () => {
            jumping.current = true;
            stick.current = false;
            keep.current = null;
        };

        const back = () => (jumping.current = false);
        const takes = ["wheel", "touchstart", "pointerdown", "keydown"];

        document.addEventListener("pocket:reveal", away);

        for (const name of takes) {
            document.addEventListener(name, back, { capture: true, passive: true });
        }

        return () => {
            document.removeEventListener("pocket:reveal", away);

            for (const name of takes) {
                document.removeEventListener(name, back, { capture: true });
            }
        };
    }, []);

    // Images finish loading after the transcript renders and make it taller: stay at the bottom if we were there.
    useEffect(() => {
        const element = scroller.current;

        if (!element) {
            return;
        }

        const onLoad = (event) => {
            if (event.target?.tagName === "IMG" && stick.current) {
                element.scrollTop = element.scrollHeight;
            }
        };

        element.addEventListener("load", onLoad, true);

        return () => element.removeEventListener("load", onLoad, true);
    }, [view.conversation?.id]);

    // A `!` command whose entry arrived is no longer pending.
    const shells = useMemo(() => rows.filter((row) => row.kind === "shell").length, [rows]);

    useEffect(() => {
        const pending = store.state.pendingShells;
        const left = pending.filter(
            (each) =>
                Date.now() - each.at < PENDING_MS &&
                !rows.some((row) => row.kind === "shell" && row.taskId === each.taskId),
        );

        if (left.length !== pending.length) {
            store.set({ pendingShells: left });
        }
    }, [shells]);

    const onScroll = () => {
        const element = scroller.current;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;

        stick.current = atBottom && !jumping.current;

        if (showJump === atBottom) {
            setShowJump(!atBottom);
        }
    };

    if (missing) {
        return html`<main class="scroller">
            <div class="empty">
                <p>${missing}</p>
                <button class="button" onClick=${() => navigate(null)}>${t("All sessions")}</button>
            </div>
        </main>`;
    }

    if (!view.conversation) {
        const { connection, sessions, conversationId } = store.state;
        const title = sessions.find((session) => session.id === conversationId)?.title;
        const caption =
            connection === "connecting"
                ? t("connecting")
                : connection === "open"
                  ? t("loading session")
                  : t("reconnecting");

        return html`<main class="scroller">
            <${Boot} inline caption=${caption} detail=${title ?? ""} />
        </main>`;
    }

    const keepPlace = () => {
        // Earlier rows arriving above are not new: they appear without sliding in.
        const id = view.conversation?.id;

        settledFor = null;
        setTimeout(() => (settledFor = id), 400);
        const element = scroller.current;

        if (!element) {
            return;
        }

        keep.current = element.scrollHeight - element.scrollTop;
        stick.current = false;
    };

    const showEarlier = () => {
        keepPlace();
        store.set({ transcriptFrom: rows[Math.max(0, start - TRANSCRIPT_ROWS)].id });
    };

    const approvals = view.approvals ?? [];
    const first = entries[0];
    const busy = view.live.busy;
    const compacting = (view.live.compactions ?? []).length > 0;
    const conversation = view.conversation;
    const started = runStart(conversation.id, entries, busy);
    // Only a session this person can see is in their list.
    const { sessions, sessionsLoaded } = store.state;
    const source =
        conversation.forkedFrom && sessions.find((each) => each.id === conversation.forkedFrom.id);

    return html`<main class="scroller" ref=${scroller} onScroll=${onScroll}>
        <div class=${`transcript ${entrance.current}`} data-part="transcript" ref=${column}>
            <${LinkedSessions} />
            ${
                conversation.forkedFrom &&
                sessionsLoaded &&
                (source
                    ? html`<button class="breadcrumb" onClick=${() => navigate(source.id)}>
                        <${Icon} name="fork" size=${14} /> ${t("Forked from {title}", { title: source.title ?? t("New session") })}
                    </button>`
                    : html`<p class="muted small">
                        <${Icon} name="fork" size=${14} /> ${t("Forked from another session")}
                    </p>`)
            }
            ${
                start > 0
                    ? html`<div class="divider">
                        <button class="link" onClick=${showEarlier}>${t("Show earlier messages")}</button>
                    </div>`
                    : first &&
                      (first.kind === "compaction" || first.kind === "reset") &&
                      html`<${History}
                          firstId=${first.id}
                          results=${results}
                          keepPlace=${keepPlace}
                          conversationId=${conversation.id}
                      />`
            }
            ${
                entries.length === 0 &&
                !view.live.busy &&
                html`<div class="empty hint">
                    <div class="pi"><img class="brand-icon" src="icon.svg" alt="" /></div>
                    <p>
                        ${conversation.kind === "subagent" ? t("This subagent has no messages yet.") : t("Ask anything. Pi works in this session's folder, and keeps working if the server restarts.")}
                    </p>
                </div>`
            }
            <${Items}
                items=${items}
                results=${results}
                slots=${slots}
                approvals=${approvals}
                busy=${busy}
                conversationId=${conversation.id}
            />
            <${PendingShells} conversationId=${conversation.id} rows=${rows} />
            ${approvals.map(
                (approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} />`,
            )}
            ${(view.limitOffers ?? []).map((offer) => html`<${LimitOfferCard} key=${`${offer.conversationId}-${offer.to}`} offer=${offer} />`)}
            <${PhoneControlLine} conversationId=${conversation.id} />
            ${
                (busy || compacting) &&
                html`<${LiveLine}
                    live=${view.live}
                    approvals=${approvals}
                    start=${started}
                    entries=${entries}
                    conversationId=${conversation.id}
                />`
            }
        </div>
        ${
            showJump &&
            html`<button
                class="jump"
                aria-label=${t("To the bottom")}
                onClick=${() => {
                    stick.current = true;
                    toBottom(scroller.current);
                    setShowJump(false);
                }}
            >
                <${Icon} name="down" />
            </button>`
        }
    </main>`;
}

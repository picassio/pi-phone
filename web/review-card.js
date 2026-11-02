// A review subagent's report as a card (PP-357, the owner's mockup of 2026-11-02; src/server/review.ts): its verdict
// as a word and a dot, the findings by priority (a tap on file:line opens the file), a suggestion, what a person should
// check, and Fix these (the fix message into the message box, not sent), Post to GitHub (a pull request's: asks Pi,
// which asks the person on a card) and Copy.
import { t, tn } from "./i18n.js";
import { actions, attempt, insertIntoComposer, notify, store } from "./store.js";
import { copyText, html, openFile, StateTag } from "./ui.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];

/** The `review-result` block at the end of a reviewer's answer, as the server reads it (`parseReviewResult`). */
export function parseReviewResult(text) {
    const blocks = [...String(text).matchAll(/```review-result\s*\n([\s\S]*?)\n```/g)];
    const last = blocks.at(-1)?.[1];

    if (last === undefined) {
        return null;
    }

    let value;

    try {
        value = JSON.parse(last);
    } catch {
        return null;
    }

    if ((value?.verdict !== "correct" && value?.verdict !== "needs attention") || !Array.isArray(value.findings)) {
        return null;
    }

    const findings = value.findings.filter((each) => PRIORITIES.includes(each?.priority) && typeof each.title === "string" && typeof each.body === "string");
    const callouts = (Array.isArray(value.callouts) ? value.callouts : []).filter((each) => typeof each?.label === "string" && typeof each.text === "string");

    return {
        verdict: value.verdict,
        findings: findings.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)),
        callouts,
    };
}

/** Where a finding is, as its row says it: "src/a.ts:88". */
const where = (each) => (each.file === undefined ? "" : each.line === undefined ? each.file : `${each.file}:${each.line}`);

/** The message Fix these puts in the box: the findings in priority order, each to fix and check with a run. */
export function fixMessage(label, result) {
    return [
        `Fix the findings of the review of ${label}, in priority order (P0, P1, then P2; P3 if quick and safe). For each, check the fix with a run (a test that failed before, or a repro), and say which you left and why.`,
        "",
        ...result.findings.map((each, index) => `${index + 1}. [${each.priority}] ${each.title}${where(each) === "" ? "" : ` (${where(each)})`}: ${each.body}`),
    ].join("\n");
}

/** The review as Markdown, for Copy. */
function markdown(label, result) {
    return [
        `## Review: ${label}`,
        "",
        `Verdict: **${result.verdict}**`,
        "",
        ...result.findings.flatMap((each) => [`- **[${each.priority}] ${each.title}**${where(each) === "" ? "" : ` \`${where(each)}\``}: ${each.body}`, ...(each.suggestion ? ["", "```", each.suggestion, "```"] : [])]),
        ...(result.callouts.length === 0 ? [] : ["", "For a person to check:", ...result.callouts.map((each) => `- **${each.label}:** ${each.text}`)]),
    ].join("\n");
}

/** A span of time in a few characters: "41 s", "1 min 12 s". */
function took(ms) {
    const seconds = Math.max(1, Math.round(ms / 1000));

    return seconds < 60 ? t("{n} s", { n: seconds }) : t("{m} min {s} s", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

export function ReviewCard({ name, child, result, fresh }) {
    const review = child?.review;
    const label = review?.label ?? name;
    const meta = [
        review?.files === undefined ? null : tn(review.files, "{n} file", "{n} files"),
        child?.askedAt !== undefined && child?.answeredAt !== undefined ? took(child.answeredAt - child.askedAt) : null,
    ].filter(Boolean);
    const bad = result.verdict !== "correct";
    const post = () =>
        attempt(() => actions.submit(`Post the review ${name} to GitHub with the review tool (action post, name ${name}).`, [], store.state.view.live?.busy ? "steer" : "followUp"));

    return html`<div class=${`report review-card ${fresh ? "enter" : ""}`} data-part="review-card">
        <div class="review-head">
            <div class="review-title">
                <div>${t("Review · {what}", { what: label })}</div>
                ${meta.length > 0 && html`<div class="muted small">${meta.join(" · ")}</div>`}
            </div>
            <${StateTag} tone=${bad ? "warn" : "ok"} label=${bad ? t("Needs attention") : t("Correct")} />
        </div>
        ${result.findings.length === 0 && html`<div class="review-finding muted small">${t("No findings.")}</div>`}
        ${result.findings.map(
            (each) => html`<div class="review-finding" data-part="review-finding">
                <div class="review-finding-title"><span class=${`review-prio ${each.priority === "P0" || each.priority === "P1" ? "urgent" : ""}`}>${each.priority}</span><span>${each.title}</span></div>
                ${where(each) !== "" && html`<button class="link mono review-where" onClick=${() => openFile(where(each))}>${where(each)}</button>`}
                <div class="review-body">${each.body}</div>
                ${each.suggestion && html`<pre class="review-suggestion">${each.suggestion}</pre>`}
            </div>`,
        )}
        ${
            result.callouts.length > 0 &&
            html`<div class="review-callouts">
                <div class="small">${t("For a person to check")}</div>
                <ul>
                    ${result.callouts.map((each) => html`<li><strong>${each.label}:</strong> ${each.text}</li>`)}
                </ul>
            </div>`
        }
        <div class="review-actions">
            ${result.findings.length > 0 && html`<button class="button small ${bad ? "primary" : ""}" data-part="review-fix" onClick=${() => insertIntoComposer(fixMessage(label, result))}>${t("Fix these")}</button>`}
            ${review?.pr !== undefined && html`<button class="button small" data-part="review-post" onClick=${post}>${t("Post to GitHub")}</button>`}
            <button
                class="button small quiet"
                onClick=${() => copyText(markdown(label, result)).then(() => notify("info", t("Copied")), () => {})}
            >
                ${t("Copy")}
            </button>
        </div>
    </div>`;
}

// `/review` with nothing after it (PP-357, the owner's mockup of 2026-11-02): what to review (the folder's changes, the
// branch against a base, a commit, a GitHub pull request, or folders), an optional focus, and Review, which sends
// `/review …` to Pi as a message; the server turns it into the review tool's call (src/server/review.ts).
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, closeSheet, store } from "../store.js";
import { Choice, html, Loader, Sheet } from "../ui.js";
import { t, tn } from "../i18n.js";
import { subagentSummary } from "./subagent-settings.js";

const KINDS = [
    { id: "changes", label: () => t("Changes") },
    { id: "branch", label: () => t("Branch") },
    { id: "commit", label: () => t("Commit") },
    { id: "pr", label: () => t("Pull request") },
    { id: "folders", label: () => t("Folders") },
];

/** A word for the command line: quoted when it has a space or a quote. */
const word = (value) => (/[\s"']/.test(value) ? `"${value.replace(/"/g, "")}"` : value);

/** The `/review …` line the sheet sends. */
export function reviewCommand(kind, value, focus) {
    const extra = focus.trim() === "" ? "" : ` --extra "${focus.trim().replace(/"/g, "'")}"`;
    const target = kind === "changes" ? "changes" : kind === "folders" ? `folder ${value.trim().split(/\s+/).map(word).join(" ")}` : `${kind} ${word(value.trim())}`;

    return `/review ${target}${extra}`;
}

export function ReviewSheet() {
    const id = store.state.conversationId;
    const [kind, setKind] = useState("changes");
    const [targets, setTargets] = useState(null);
    const [branches, setBranches] = useState(null);
    const [problem, setProblem] = useState(null);
    const [pr, setPr] = useState("");
    const [base, setBase] = useState("");
    const [commit, setCommit] = useState("");
    const [folders, setFolders] = useState("");
    const [focus, setFocus] = useState("");

    useEffect(() => {
        api(`c/${id}/review-targets`).then(
            (found) => {
                setTargets(found);
                setPr(found.prs[0] === undefined ? "" : String(found.prs[0].number));
                setCommit(found.commits[0]?.sha ?? "");
            },
            (error) => setProblem(error.message),
        );
        actions.branches().then(
            (found) => {
                setBranches(found);
                const current = found.local.find((each) => each.current)?.name;
                const main = found.local.find((each) => each.name === "main" || each.name === "master")?.name;

                setBase(main !== undefined && main !== current ? main : (found.local.find((each) => !each.current)?.name ?? ""));
            },
            () => setBranches({ local: [], remote: [] }),
        );
    }, [id]);

    const value = kind === "pr" ? pr : kind === "branch" ? base : kind === "commit" ? commit : kind === "folders" ? folders : "";
    const ready = kind === "changes" || value.trim() !== "";
    const start = () =>
        attempt(async () => {
            await actions.submit(reviewCommand(kind, value, focus), [], store.state.view.live?.busy ? "steer" : "followUp");
            closeSheet();
        });

    return html`<${Sheet} title=${t("Review")} onClose=${closeSheet} className="review-sheet">
        ${problem && html`<p class="wiki-problem">${problem}</p>`}
        ${!problem && targets === null && html`<${Loader} label=${t("Looking at the repository")} />`}
        ${
            targets &&
            html`<div class="field">
                    <div class="label">${t("What to review")}</div>
                    <div class="segmented" role="group" aria-label=${t("What to review")} data-part="review-kind">
                        ${KINDS.map((each) => html`<button class=${kind === each.id ? "on" : ""} aria-pressed=${kind === each.id} onClick=${() => setKind(each.id)}>${each.label()}</button>`)}
                    </div>
                </div>
                ${
                    kind === "pr" &&
                    html`<div class="field" data-part="review-pr">
                        <div class="label">${t("Pull request")}</div>
                        ${
                            targets.prs.length > 0
                                ? html`<${Choice}
                                      label=${t("Pull request")}
                                      value=${pr}
                                      options=${targets.prs.map((each) => ({
                                          value: String(each.number),
                                          label: `#${each.number} ${each.title}`,
                                          detail: `${each.head} → ${each.base} · ${tn(each.files, "{n} file", "{n} files")}`,
                                      }))}
                                      onChange=${setPr}
                                  />`
                                : html`<input placeholder=${t("Number or link")} value=${pr} onInput=${(event) => setPr(event.currentTarget.value)} />`
                        }
                        ${targets.prsError && html`<div class="muted small">${t("gh could not list the pull requests: {why}", { why: targets.prsError })}</div>`}
                    </div>`
                }
                ${
                    kind === "branch" &&
                    html`<div class="field" data-part="review-branch">
                        <div class="label">${t("Against the base branch")}</div>
                        ${
                            branches === null
                                ? html`<${Loader} label=${t("Loading branches")} />`
                                : html`<${Choice}
                                      label=${t("Against the base branch")}
                                      value=${base}
                                      options=${[...branches.local.filter((each) => !each.current).map((each) => ({ value: each.name, label: each.name })), ...branches.remote.map((each) => ({ value: each.name, label: each.name, detail: t("remote") }))]}
                                      onChange=${setBase}
                                  />`
                        }
                    </div>`
                }
                ${
                    kind === "commit" &&
                    html`<div class="field" data-part="review-commit">
                        <div class="label">${t("Commit")}</div>
                        <${Choice}
                            label=${t("Commit")}
                            value=${commit}
                            options=${targets.commits.map((each) => ({ value: each.sha, label: each.title, detail: each.sha }))}
                            onChange=${setCommit}
                        />
                    </div>`
                }
                ${
                    kind === "folders" &&
                    html`<div class="field" data-part="review-folders">
                        <div class="label">${t("Folders or files")}</div>
                        <input class="mono" placeholder="src web" value=${folders} onInput=${(event) => setFolders(event.currentTarget.value)} />
                    </div>`
                }
                <div class="field" data-part="review-focus">
                    <div class="label">${t("Focus (optional)")}</div>
                    <input placeholder=${t("e.g. error handling and performance")} value=${focus} onInput=${(event) => setFocus(event.currentTarget.value)} />
                    ${targets.guidelines && html`<div class="muted small">${t("Uses REVIEW_GUIDELINES.md from this project")}</div>`}
                </div>
                <div class="sheet-actions review-actions">
                    <span class="muted small">${t("Subagents: {summary}", { summary: subagentSummary(store.state.view.conversation?.subagentDefaults) })}</span>
                    <button class="button primary" data-part="review-start" disabled=${!ready} onClick=${start}>${t("Review")}</button>
                </div>`
        }
    <//>`;
}

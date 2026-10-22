// The form of an interview Pi asked (src/server/interviews.ts, extensions/interview.ts): its questions as pi-interview
// writes them, answered here. Every change is saved as the person goes, so they can close it and come back; Submit
// ends it with the answers, Skip without (what is answered still reaches Pi).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { HtmlPreview, Highlighted } from "../rich.js";
import { api, attempt, canSteer, closeSheet, notify } from "../store.js";
import { fileUrl, html, Icon, Loader, Markdown, Sheet } from "../ui.js";
import { t, tn } from "../i18n.js";

const labelOf = (option) => (typeof option === "string" ? option : option.label);

/** The options a question recommends. */
function recommended(question) {
    return question.recommended === undefined
        ? []
        : Array.isArray(question.recommended)
          ? question.recommended
          : [question.recommended];
}

/** A content block: Markdown shown as Markdown (unless its source is asked for), anything else as code. */
function Content({ block, conversationId }) {
    const markdown = (block.lang === "md" || block.lang === "markdown") && !block.showSource;

    return html`<div class="interview-content">
        ${block.title && html`<div class="muted small mono">${block.title}</div>`}
        ${
            markdown
                ? html`<${Markdown} text=${block.source} conversationId=${conversationId} />`
                : html`<${Highlighted} class="output" text=${block.source} lang=${block.lang ?? block.file ?? ""} />`
        }
    </div>`;
}

/** A media block: an image, a table, a Mermaid diagram, a page; Chart.js charts are not drawn here. */
function Media({ block, conversationId }) {
    let body;

    if (block.type === "image") {
        const src = /^(data:image\/|https?:)/i.test(block.src) ? block.src : fileUrl(block.src, conversationId);

        body = html`<img class="interview-image" src=${src} alt=${block.alt ?? ""} />`;
    } else if (block.type === "table") {
        const marked = new Set(block.table.highlights ?? []);

        body = html`<div class="interview-table"><table>
            <thead><tr>${block.table.headers.map((head) => html`<th>${head}</th>`)}</tr></thead>
            <tbody>
                ${block.table.rows.map((row, index) => html`<tr class=${marked.has(index) ? "on" : ""}>${row.map((cell) => html`<td>${cell}</td>`)}</tr>`)}
            </tbody>
        </table></div>`;
    } else if (block.type === "mermaid") {
        body = html`<${Markdown} text=${`\`\`\`mermaid\n${block.mermaid}\n\`\`\``} conversationId=${conversationId} />`;
    } else if (block.type === "html") {
        body = html`<${HtmlPreview} source=${block.html} />`;
    } else {
        body = html`<p class="muted small">${t("A {type} chart: charts show here as Mermaid (pie, xychart).", { type: block.chart?.type ?? "" })}</p>`;
    }

    return html`<figure class="interview-media" style=${block.maxHeight ? `max-height:${block.maxHeight};overflow:auto` : ""}>
        ${body}
        ${block.caption && html`<figcaption class="muted small">${block.caption}</figcaption>`}
    </figure>`;
}

/** Suggestions for asking about an option, as pi-interview offers them, in the person's language. */
const askChips = () => [t("Pros and cons?"), t("When is this the right pick?"), t("What would it take?")];

/**
 * Ask about one option (`interview-helpers.ts`): the thread so far, kept with the interview, suggestions, and a box
 * for a question of one's own. Answers come from the session's model.
 */
function AskPanel({ option, thread, helpers, conversationId }) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const send = async (prompt) => {
        setBusy(true);

        try {
            if (await helpers.ask(option, prompt)) {
                setText("");
            }
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="interview-asked">
        ${thread.map(
            (turn) => html`<div class="interview-asked-turn" key=${turn.at}>
                <div class="interview-asked-q">${turn.q}</div>
                <div class="interview-asked-a"><${Markdown} text=${turn.a} conversationId=${conversationId} /></div>
            </div>`,
        )}
        ${busy && html`<${Loader} label=${t("Asking")} />`}
        <div class="interview-chips">
            ${askChips().map((chip) => html`<button class="button small" disabled=${busy} onClick=${() => send(chip)}>${chip}</button>`)}
        </div>
        <div class="row">
            <input
                aria-label=${t("Ask about {option}", { option })}
                placeholder=${t("Ask about this option…")}
                value=${text}
                disabled=${busy}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && text.trim() !== "" && send(text)}
            />
            <button class="button small primary" disabled=${busy || text.trim() === ""} onClick=${() => send(text)}>${t("Ask")}</button>
        </div>
    </div>`;
}

/** A review's proposal: the question and its options rewritten, to take or leave. */
function ReviewProposal({ review, onUse, onDismiss, busy }) {
    return html`<div class="interview-review">
        <div class="label">${t("Suggested rewrite")}</div>
        <div class="interview-review-question">${review.question}</div>
        <ul>
            ${review.options.map((option) => html`<li>${option}</li>`)}
        </ul>
        ${review.why && html`<p class="muted small">${review.why}</p>`}
        <div class="sheet-actions">
            <button class="button small" disabled=${busy} onClick=${onDismiss}>${t("Keep mine")}</button>
            <button class="button small primary" disabled=${busy} onClick=${onUse}>${t("Use it")}</button>
        </div>
    </div>`;
}

/** Single or multiple choice: options with a Recommended badge, a note on a chosen one, and Other with its own words. */
function Choices({ question, answer, onChange, disabled, conversationId, helpers, asked }) {
    const [asking, setAsking] = useState(null);
    const [review, setReview] = useState(null);
    const [busy, setBusy] = useState(null);
    const run = async (what, work) => {
        setBusy(what);

        try {
            return await work();
        } finally {
            setBusy(null);
        }
    };
    const multi = question.type === "multi";
    const chosen = answer === undefined ? [] : Array.isArray(answer.value) ? answer.value : [answer.value];
    const labels = question.options.map(labelOf);
    const other = chosen.find((choice) => !labels.includes(choice.option));
    const picks = recommended(question);
    const set = (list) => onChange(list.length === 0 ? undefined : { id: question.id, value: multi ? list : list[0] });
    const toggle = (option, on) =>
        set(multi ? (on ? [...chosen, { option }] : chosen.filter((choice) => choice.option !== option)) : on ? [{ option }] : []);
    const note = (option, text) =>
        set(chosen.map((choice) => (choice.option === option ? { option, ...(text === "" ? {} : { note: text }) } : choice)));
    const [otherOn, setOtherOn] = useState(other !== undefined);
    const otherText = other?.option ?? "";
    const setOther = (text) => {
        const rest = chosen.filter((choice) => labels.includes(choice.option));

        set(text === "" ? rest : multi ? [...rest, { option: text }] : [{ option: text }]);
    };

    return html`<div class="interview-options" role=${multi ? "group" : "radiogroup"}>
        ${question.options.map((option) => {
            const label = labelOf(option);
            const choice = chosen.find((each) => each.option === label);

            return html`<div class=${`interview-option ${choice ? "on" : ""}`} key=${label}>
                <label>
                    <input
                        type=${multi ? "checkbox" : "radio"}
                        name=${question.id}
                        checked=${choice !== undefined}
                        disabled=${disabled}
                        onChange=${(event) => {
                            setOtherOn(multi && otherOn);
                            toggle(label, event.currentTarget.checked);
                        }}
                    />
                    <span>${label}</span>
                    ${picks.includes(label) && question.conviction !== "slight" && html`<span class="badge">${t("Recommended")}</span>`}
                    ${
                        helpers &&
                        !disabled &&
                        html`<button
                            class=${`link small interview-ask-button ${asking === label ? "on" : ""}`}
                            aria-expanded=${asking === label ? "true" : "false"}
                            onClick=${(event) => {
                                event.preventDefault();
                                setAsking(asking === label ? null : label);
                            }}
                        >
                            ${(asked?.[`${question.id}\n${label}`]?.length ?? 0) > 0 ? t("Ask ({n})", { n: asked[`${question.id}\n${label}`].length }) : t("Ask")}
                        </button>`
                    }
                </label>
                ${typeof option !== "string" && option.content && html`<${Content} block=${option.content} conversationId=${conversationId} />`}
                ${
                    choice &&
                    html`<input
                        class="interview-note"
                        placeholder=${t("Optional clarification…")}
                        value=${choice.note ?? ""}
                        disabled=${disabled}
                        onInput=${(event) => note(label, event.currentTarget.value)}
                    />`
                }
                ${
                    helpers &&
                    asking === label &&
                    html`<${AskPanel}
                        option=${label}
                        thread=${asked?.[`${question.id}\n${label}`] ?? []}
                        helpers=${{ ask: (option, prompt) => helpers.ask(question.id, option, prompt) }}
                        conversationId=${conversationId}
                    />`
                }
            </div>`;
        })}
        <div class=${`interview-option ${otherOn ? "on" : ""}`}>
            <label>
                <input
                    type=${multi ? "checkbox" : "radio"}
                    name=${question.id}
                    checked=${otherOn}
                    disabled=${disabled}
                    onChange=${(event) => {
                        const on = event.currentTarget.checked;

                        setOtherOn(on);

                        if (!on) {
                            setOther("");
                        } else if (!multi) {
                            set([]);
                        }
                    }}
                />
                <span>${t("Other")}</span>
            </label>
            ${
                otherOn &&
                html`<input
                    class="interview-note"
                    placeholder=${t("Your answer")}
                    value=${otherText}
                    disabled=${disabled}
                    onInput=${(event) => setOther(event.currentTarget.value)}
                />`
            }
        </div>
        ${
            review &&
            html`<${ReviewProposal}
                review=${review}
                busy=${busy !== null}
                onDismiss=${() => setReview(null)}
                onUse=${() =>
                    run("use", async () => {
                        if (await helpers.useReview(question.id, review)) {
                            setReview(null);
                        }
                    })}
            />`
        }
        ${
            helpers &&
            !disabled &&
            html`<div class="interview-helpers">
                <button class="button small" disabled=${busy !== null} onClick=${() => run("more", () => helpers.more(question.id))}>
                    ${busy === "more" ? t("Thinking…") : t("✦ More options")}
                </button>
                <button
                    class="button small"
                    disabled=${busy !== null}
                    onClick=${() =>
                        run("review", async () => {
                            const found = await helpers.review(question.id);

                            if (found) {
                                setReview(found);
                            }
                        })}
                >
                    ${busy === "review" ? t("Reviewing…") : t("↻ Review")}
                </button>
            </div>`
        }
    </div>`;
}

/** Photos for an image question: taken or picked, uploaded to the session's files; Pi gets their paths. */
function Images({ question, answer, onChange, disabled, conversationId }) {
    const paths = answer === undefined ? [] : Array.isArray(answer.value) ? answer.value : [answer.value];
    const [busy, setBusy] = useState(false);
    const input = useRef(null);
    const add = (files) =>
        attempt(async () => {
            setBusy(true);

            try {
                const added = [];

                for (const file of files) {
                    added.push((await api(`c/${conversationId}/upload?name=${encodeURIComponent(file.name || "photo.jpg")}`, file)).path);
                }

                onChange({ id: question.id, value: [...paths, ...added] });
            } finally {
                setBusy(false);
            }
        });
    const remove = (path) => {
        const rest = paths.filter((each) => each !== path);

        onChange(rest.length === 0 ? undefined : { id: question.id, value: rest });
    };

    return html`<div class="interview-images">
        ${paths.map(
            (path) => html`<span class="interview-thumb" key=${path}>
                <img src=${fileUrl(path, conversationId)} alt="" />
                ${!disabled && html`<button class="icon-button" aria-label=${t("Remove")} onClick=${() => remove(path)}><${Icon} name="close" size=${14} /></button>`}
            </span>`,
        )}
        <input
            ref=${input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange=${(event) => {
                add([...event.currentTarget.files]);
                event.currentTarget.value = "";
            }}
        />
        ${
            !disabled &&
            html`<button class="button small" disabled=${busy} onClick=${() => input.current?.click()}>
                ${busy ? t("Uploading…") : paths.length === 0 ? t("Add a photo") : t("Add more")}
            </button>`
        }
    </div>`;
}

function QuestionCard({ question, answer, onChange, disabled, conversationId, helpers, asked }) {
    const media = question.media === undefined ? [] : Array.isArray(question.media) ? question.media : [question.media];
    const where = (position) => media.filter((block) => (block.position ?? "above") === position);
    const side = where("side");

    return html`<section class=${`interview-question ${question.weight ?? ""} ${question.type}`} data-question=${question.id}>
        <div class="interview-ask"><${Markdown} text=${question.question} conversationId=${conversationId} /></div>
        ${question.context && html`<div class="muted small interview-context"><${Markdown} text=${question.context} conversationId=${conversationId} /></div>`}
        ${where("above").map((block) => html`<${Media} block=${block} conversationId=${conversationId} />`)}
        <div class=${side.length > 0 ? "interview-side" : ""}>
            <div>
                ${question.content && html`<${Content} block=${question.content} conversationId=${conversationId} />`}
                ${
                    (question.type === "single" || question.type === "multi") &&
                    html`<${Choices}
                        question=${question}
                        answer=${answer}
                        onChange=${onChange}
                        disabled=${disabled}
                        conversationId=${conversationId}
                        helpers=${helpers}
                        asked=${asked}
                    />`
                }
                ${
                    question.type === "text" &&
                    html`<textarea
                        rows="3"
                        aria-label=${question.question}
                        value=${answer?.value ?? ""}
                        disabled=${disabled}
                        onInput=${(event) => {
                            const text = event.currentTarget.value;

                            onChange(text === "" ? undefined : { id: question.id, value: text });
                        }}
                    ></textarea>`
                }
                ${
                    question.type === "image" &&
                    html`<${Images} question=${question} answer=${answer} onChange=${onChange} disabled=${disabled} conversationId=${conversationId} />`
                }
            </div>
            ${side.length > 0 && html`<div>${side.map((block) => html`<${Media} block=${block} conversationId=${conversationId} />`)}</div>`}
        </div>
        ${where("below").map((block) => html`<${Media} block=${block} conversationId=${conversationId} />`)}
    </section>`;
}

export function InterviewSheet({ conversationId, callId }) {
    const [interview, setInterview] = useState(null);
    const [draft, setDraft] = useState([]);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const saving = useRef(null);
    const path = `c/${conversationId}/interviews/${callId.split("/").map(encodeURIComponent).join("/")}`;

    useEffect(() => {
        api(path).then(
            (found) => {
                setInterview(found);
                setDraft(found.draft);
            },
            (error) => setProblem(error.message),
        );
    }, [path]);

    const byId = useMemo(() => new Map(draft.map((item) => [item.id, item])), [draft]);
    const waiting = interview?.status === "waiting";
    const send = (action, next = draft) => api(path, { draft: next, action });
    const change = (id, item) => {
        const next = [...draft.filter((each) => each.id !== id), ...(item === undefined ? [] : [item])];

        setDraft(next);
        clearTimeout(saving.current);
        // Saved as they go, a moment after they stop.
        saving.current = setTimeout(() => send("save", next).catch((error) => notify("error", error.message)), 600);
    };
    const finish = (action) =>
        attempt(async () => {
            setBusy(true);
            clearTimeout(saving.current);

            try {
                await send(action);
                closeSheet();
            } finally {
                setBusy(false);
            }
        });
    /**
     * The helpers on the session's model (`interview-helpers.ts`). What was typed is saved first, so a change the
     * server makes (options added, a review used) starts from it. Each gives what it found, or undefined after saying why.
     */
    const helper = (body) =>
        attempt(async () => {
            clearTimeout(saving.current);
            await send("save");
            const found = await api(`c/${conversationId}/interview-helpers`, { callId, ...body });

            if (found.interview) {
                setInterview(found.interview);
                setDraft(found.interview.draft);
            }

            return found;
        });
    const helpers = {
        more: (question) => helper({ action: "more", question }),
        review: (question) => helper({ action: "review", question }).then((found) => found?.review),
        useReview: (question, review) => helper({ action: "use-review", question, review }),
        ask: (question, option, prompt) => helper({ action: "ask", question, option, prompt }),
    };
    const questions = interview?.questions.questions ?? [];
    const unanswered = questions.filter((question) => question.type !== "info" && !byId.has(question.id)).length;

    // Skip and Submit in the header, always in reach however long the form is.
    const actions =
        waiting &&
        html`<button class="button small" disabled=${busy} onClick=${() => finish("cancel")}>${t("Skip")}</button>
            <button class="button small primary" disabled=${busy} onClick=${() => finish("submit")}>${t("Submit")}</button>`;

    return html`<${Sheet} title=${interview?.questions.title ?? t("Interview")} onClose=${closeSheet} className="interview" actions=${actions} wide>
        ${problem && html`<p class="wiki-problem">${problem}</p>`}
        ${!interview && !problem && html`<${Loader} label=${t("Loading the questions")} />`}
        ${
            interview &&
            html`${interview.questions.description && html`<div class="interview-description"><${Markdown} text=${interview.questions.description} conversationId=${conversationId} /></div>`}
            ${!waiting && html`<p class="muted small">${interview.by ? t("This interview ended ({status}, by {who}).", { status: interview.status, who: interview.by }) : t("This interview ended ({status}).", { status: interview.status })}</p>`}
            ${questions.map(
                (question) => html`<${QuestionCard}
                    key=${question.id}
                    question=${question}
                    answer=${byId.get(question.id)}
                    onChange=${(item) => change(question.id, item)}
                    disabled=${!waiting || busy}
                    conversationId=${conversationId}
                    helpers=${waiting && canSteer() ? helpers : null}
                    asked=${interview.asked}
                />`,
            )}
            ${
                waiting &&
                html`<p class="muted small interview-status">
                    ${unanswered === 0 ? t("All answered.") : tn(unanswered, "{n} not answered yet.", "{n} not answered yet.")} ${t("Saved as you go: close it and come back any time. Submit is at the top.")}
                </p>`
            }`
        }
    <//>`;
}

// The form of an interview Pi asked (src/server/interviews.ts, extensions/interview.ts): its questions as pi-interview
// writes them, answered here. Every change is saved as the person goes, so they can close it and come back; Submit
// ends it with the answers, Skip without (what is answered still reaches Pi).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { HtmlPreview, Highlighted } from "../rich.js";
import { api, attempt, closeSheet, notify } from "../store.js";
import { fileUrl, html, Icon, Loader, Markdown, Sheet } from "../ui.js";

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
        body = html`<p class="muted small">A ${block.chart?.type ?? ""} chart: charts show here as Mermaid (pie, xychart).</p>`;
    }

    return html`<figure class="interview-media" style=${block.maxHeight ? `max-height:${block.maxHeight};overflow:auto` : ""}>
        ${body}
        ${block.caption && html`<figcaption class="muted small">${block.caption}</figcaption>`}
    </figure>`;
}

/** Single or multiple choice: options with a Recommended badge, a note on a chosen one, and Other with its own words. */
function Choices({ question, answer, onChange, disabled, conversationId }) {
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
                    ${picks.includes(label) && question.conviction !== "slight" && html`<span class="badge">Recommended</span>`}
                </label>
                ${typeof option !== "string" && option.content && html`<${Content} block=${option.content} conversationId=${conversationId} />`}
                ${
                    choice &&
                    html`<input
                        class="interview-note"
                        placeholder="Optional clarification…"
                        value=${choice.note ?? ""}
                        disabled=${disabled}
                        onInput=${(event) => note(label, event.currentTarget.value)}
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
                <span>Other</span>
            </label>
            ${
                otherOn &&
                html`<input
                    class="interview-note"
                    placeholder="Your answer"
                    value=${otherText}
                    disabled=${disabled}
                    onInput=${(event) => setOther(event.currentTarget.value)}
                />`
            }
        </div>
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
                ${!disabled && html`<button class="icon-button" aria-label="Remove" onClick=${() => remove(path)}><${Icon} name="close" size=${14} /></button>`}
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
                ${busy ? "Uploading…" : paths.length === 0 ? "Add a photo" : "Add more"}
            </button>`
        }
    </div>`;
}

function QuestionCard({ question, answer, onChange, disabled, conversationId }) {
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
                    html`<${Choices} question=${question} answer=${answer} onChange=${onChange} disabled=${disabled} conversationId=${conversationId} />`
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
    const questions = interview?.questions.questions ?? [];
    const unanswered = questions.filter((question) => question.type !== "info" && !byId.has(question.id)).length;

    return html`<${Sheet} title=${interview?.questions.title ?? "Interview"} onClose=${closeSheet} className="interview" wide>
        ${problem && html`<p class="wiki-problem">${problem}</p>`}
        ${!interview && !problem && html`<${Loader} label="Loading the questions" />`}
        ${
            interview &&
            html`${interview.questions.description && html`<div class="interview-description"><${Markdown} text=${interview.questions.description} conversationId=${conversationId} /></div>`}
            ${!waiting && html`<p class="muted small">This interview ended (${interview.status}${interview.by ? `, by ${interview.by}` : ""}).</p>`}
            ${questions.map(
                (question) => html`<${QuestionCard}
                    key=${question.id}
                    question=${question}
                    answer=${byId.get(question.id)}
                    onChange=${(item) => change(question.id, item)}
                    disabled=${!waiting || busy}
                    conversationId=${conversationId}
                />`,
            )}
            ${
                waiting &&
                html`<div class="sheet-actions interview-actions">
                    <span class="muted small grow">${unanswered === 0 ? "All answered." : `${unanswered} not answered yet.`} Saved as you go.</span>
                    <button class="button" disabled=${busy} onClick=${() => finish("cancel")}>Skip</button>
                    <button class="button primary" disabled=${busy} onClick=${() => finish("submit")}>Submit</button>
                </div>`
            }`
        }
    <//>`;
}

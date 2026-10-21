// Interactive answers (OpenUI Lang, src/frames/intelligent-ui.tsx): the frame that draws one, and what it asks of the
// app. The frame runs in the artifacts' sandbox with an opaque origin, so it reaches the app only by message, and only
// this page answers it: the program and the theme it is given, the photos and routes its components fetch (through the
// signed-in API, src/server/openui.ts), a button's words for Pi (`@ToAssistant`), its height, and what was typed and picked
// in it, kept in the conversation (`answer-state`) so the answer shows it again on any device.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, store } from "./store.js";
import { modeOf, paletteOf } from "./theme.js";
import { html } from "./ui.js";

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1600;
const ROUTES = new Set(["wiki", "image-search", "street-route"]);

/** How long the state waits for typing to pause before it is kept. */
const SAVE_AFTER_MS = 600;

/** A short, stable key for an answer: two 32-bit FNV-1a hashes of what identifies it. */
export function answerKey(prefix, text) {
    let a = 0x811c9dc5;
    let b = 0x01000193;

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);

        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
    }

    return `${prefix}-${a.toString(36)}${b.toString(36)}-${text.length.toString(36)}`;
}

/** A button's words for Pi, with what the answer sent along: its form's values and any context, as a short note. */
function askText(data) {
    const extra = [];

    if (data.form && typeof data.form === "object" && Object.keys(data.form).length > 0) {
        extra.push(`Form: ${JSON.stringify(data.form)}`);
    }

    if (data.context !== undefined && data.context !== null) {
        extra.push(`Context: ${JSON.stringify(data.context)}`);
    }

    return [String(data.text ?? "").slice(0, 2000), ...extra.map((line) => line.slice(0, 4000))].filter((line) => line !== "").join("\n\n");
}

/**
 * An interactive answer in a frame: `program` (a block in a reply, sent once the frame is ready), or `src` (an `openui`
 * artifact's page, which holds its own). `fill`: the frame takes its container's height (the artifact viewer) instead of
 * fitting the answer's.
 */
export function OpenUiFrame({ program = null, src = null, title = "Answer", fill = false }) {
    const ref = useRef(null);
    const [height, setHeight] = useState(240);
    const theme = modeOf(paletteOf()) === "dark" ? "dark" : "light";
    const address = src ?? `a/openui?theme=${theme}`;
    const conversationId = store.state.conversationId;
    // Blocks by their program; artifacts by their address (its version is in it).
    const key = program !== null ? answerKey("p", program) : answerKey("a", String(src).split("?")[0]);

    useEffect(() => {
        let timer;
        let latest;
        const save = () => {
            timer = undefined;

            if (latest !== undefined && conversationId !== undefined && canSteer()) {
                attempt(() => api(`c/${conversationId}/answer-state/${key}`, { state: latest }, { method: "PUT" }));
            }
        };

        const onMessage = async (event) => {
            const frame = ref.current;
            const data = event.data;

            if (!frame || event.source !== frame.contentWindow || typeof data?.type !== "string") {
                return;
            }

            const reply = (message) => frame.contentWindow?.postMessage(message, "*");

            if (data.type === "iui-ready") {
                // What was typed and picked before; without a conversation, or when it cannot be read, it starts empty.
                const kept =
                    conversationId === undefined
                        ? null
                        : await api(`c/${conversationId}/answer-state/${key}`).then(
                              (answer) => answer.state,
                              () => null,
                          );

                reply({ type: "iui-program", program, theme, state: kept });
            } else if (data.type === "iui-state" && data.state && typeof data.state === "object") {
                latest = data.state;
                clearTimeout(timer);
                timer = setTimeout(save, SAVE_AFTER_MS);
            } else if (data.type === "iui-size" && typeof data.height === "number" && Number.isFinite(data.height)) {
                setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(data.height))));
            } else if (data.type === "iui-fetch" && ROUTES.has(data.path) && Number.isInteger(data.id)) {
                const query = typeof data.query === "string" && data.query.startsWith("?") ? data.query : "";

                try {
                    const response = await fetch(`api/openui/${data.path}${query}`, { headers: { "X-Pocket": "1" } });

                    reply({
                        type: "iui-fetch-reply",
                        id: data.id,
                        status: response.status,
                        body: await response.text(),
                        contentType: response.headers.get("content-type") ?? "application/json",
                    });
                } catch (error) {
                    reply({ type: "iui-fetch-reply", id: data.id, status: 502, body: JSON.stringify({ error: { message: String(error) } }), contentType: "application/json" });
                }
            } else if (data.type === "iui-ask") {
                const text = askText(data);

                if (text !== "") {
                    attempt(() => actions.submit(text, [], "followUp"));
                }
            }
        };

        addEventListener("message", onMessage);

        return () => {
            removeEventListener("message", onMessage);

            // Leaving with typing not yet kept: keep it now.
            if (timer !== undefined) {
                clearTimeout(timer);
                save();
            }
        };
    }, [program, theme, key, conversationId]);

    return html`<iframe
        ref=${ref}
        class=${`openui-frame ${fill ? "fill" : ""}`}
        src=${address}
        sandbox=${SANDBOX}
        allow="clipboard-write; fullscreen"
        title=${title}
        style=${fill ? "" : `height:${height}px`}
    ></iframe>`;
}

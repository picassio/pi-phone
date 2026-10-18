// Interactive answers (OpenUI Lang, src/frames/intelligent-ui.tsx): the frame that draws one, and what it asks of the
// app. The frame runs in the artifacts' sandbox with an opaque origin, so it reaches the app only by message, and only
// this page answers it: the program and the theme it is given, the photos and routes its components fetch (through the
// signed-in API, src/server/openui.ts), a button's words for Pi (`@ToAssistant`), and its height.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, attempt } from "./store.js";
import { modeOf, paletteOf } from "./theme.js";
import { html } from "./ui.js";

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1600;
const ROUTES = new Set(["wiki", "image-search", "street-route"]);

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
    const address = src ?? `/a/openui?theme=${theme}`;

    useEffect(() => {
        const onMessage = async (event) => {
            const frame = ref.current;
            const data = event.data;

            if (!frame || event.source !== frame.contentWindow || typeof data?.type !== "string") {
                return;
            }

            const reply = (message) => frame.contentWindow?.postMessage(message, "*");

            if (data.type === "iui-ready" && program !== null) {
                reply({ type: "iui-program", program, theme });
            } else if (data.type === "iui-size" && typeof data.height === "number" && Number.isFinite(data.height)) {
                setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(data.height))));
            } else if (data.type === "iui-fetch" && ROUTES.has(data.path) && Number.isInteger(data.id)) {
                const query = typeof data.query === "string" && data.query.startsWith("?") ? data.query : "";

                try {
                    const response = await fetch(`/api/openui/${data.path}${query}`, { headers: { "X-Pocket": "1" } });

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

        return () => removeEventListener("message", onMessage);
    }, [program, theme]);

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

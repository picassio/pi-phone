/**
 * The frame that draws an interactive answer: a program in OpenUI Lang 1.0, rendered with Open Intelligent UI's
 * component library (third_party/open-intelligent-ui, MIT). Built by scripts/intelligent-ui.ts into
 * web/vendor/intelligent-ui/frame.js, and loaded by the page `/a/openui` (src/server/http/artifacts.ts), which runs in a
 * sandbox with an opaque origin: it can reach the network (map tiles, photos), never the app or its cookies.
 *
 * What it needs from the app goes through its parent, the app's page, by message (web/openui.js):
 * - the program, when the page does not hold one (a block in a reply): `{ type: "iui-program", program, theme }`;
 * - what the library's components fetch from their own server (`/api/wiki`, `/api/image-search`, `/api/street-route`):
 *   the app answers from its routes (src/server/openui.ts), signed in, so the frame needs no sign-in;
 * - a button's `@ToAssistant`: the app sends its words to Pi in the session;
 * - its height, so the app fits the frame to it;
 * - what was typed and picked: the app sends what it kept with the program (`state`), and keeps each change
 *   (`iui-state`), so the answer shows it again when the conversation opens again.
 * Messages count only from the parent window.
 */
import { type ActionEvent, type OpenUIError, Renderer } from "@openuidev/react-lang";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { runLibraryAction } from "../../third_party/open-intelligent-ui/lib/actions";
import { library } from "../../third_party/open-intelligent-ui/lib/library";

type Theme = "light" | "dark";
type FetchReply = { type: "iui-fetch-reply"; id: number; status: number; body: string; contentType: string };
type ProgramMessage = { type: "iui-program"; program: string | null; theme?: Theme; state?: Record<string, unknown> | null };

const inFrame = window.parent !== window;
const post = (message: Record<string, unknown>) => inFrame && window.parent.postMessage(message, "*");

// ─── What the components fetch from their own server, through the app ─────────────────────────────────────────────

const PROXIED = /^\/api\/(wiki|image-search|street-route)$/;
const waiting = new Map<number, (response: Response) => void>();
let calls = 0;
const direct = window.fetch.bind(window);

window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);

    if (!inFrame || url.origin !== location.origin || !PROXIED.test(url.pathname)) {
        return direct(input, init);
    }

    const id = ++calls;

    return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;

        signal?.addEventListener("abort", () => {
            waiting.delete(id);
            reject(new DOMException("Aborted", "AbortError"));
        });
        waiting.set(id, resolve);
        post({ type: "iui-fetch", id, path: url.pathname.replace(/^\/api\//, ""), query: url.search });
    });
};

// ─── The answer ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The program the page holds (an artifact), if any. */
function embedded(): string | null {
    const holder = document.getElementById("program");

    return holder?.textContent ? (JSON.parse(holder.textContent) as string) : null;
}

const initialTheme = (): Theme => (new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");

function Answer() {
    // In the app, the answer waits for the app's message: the program or the page's own, with what was kept. Opened in
    // a tab of its own, it draws the page's program at once, with nothing kept.
    const [program, setProgram] = useState<string | null>(inFrame ? null : embedded);
    const [kept, setKept] = useState<Record<string, unknown> | undefined>(undefined);
    const [theme, setTheme] = useState<Theme>(initialTheme);
    const [errors, setErrors] = useState<OpenUIError[]>([]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.source !== window.parent) {
                return;
            }

            const data = event.data as FetchReply | ProgramMessage | { type?: unknown };

            if (data.type === "iui-fetch-reply") {
                const reply = data as FetchReply;
                const resolve = waiting.get(reply.id);

                waiting.delete(reply.id);
                resolve?.(new Response(reply.body, { status: reply.status, headers: { "content-type": reply.contentType } }));
            } else if (data.type === "iui-program") {
                const message = data as ProgramMessage;

                setKept(message.state && typeof message.state === "object" ? message.state : undefined);
                setProgram(message.program ?? embedded());
                setTheme(message.theme === "dark" ? "dark" : "light");
            }
        };

        addEventListener("message", onMessage);
        post({ type: "iui-ready" });

        return () => removeEventListener("message", onMessage);
    }, []);

    // The frame's height, for the app to fit it: the page's, as it changes.
    useEffect(() => {
        const report = () => post({ type: "iui-size", height: Math.ceil(document.documentElement.scrollHeight) });
        const observer = new ResizeObserver(report);

        observer.observe(document.body);
        report();

        return () => observer.disconnect();
    }, []);

    const onAction = (event: ActionEvent) => {
        // The library's own (copy to clipboard); then what only the app can do: send Pi a message.
        if (runLibraryAction(event) !== null) {
            return;
        }

        if (event.type === "continue_conversation") {
            // The form's values and the step's context go along, as the guide promises.
            post({ type: "iui-ask", text: event.humanFriendlyMessage, form: event.formState ?? null, context: event.params.context ?? null });
        } else if (event.type === "open_url" && typeof event.params.url === "string") {
            window.open(event.params.url, "_blank", "noopener");
        }
    };

    document.documentElement.dataset.theme = theme;

    return (
        <div data-theme={theme} className="pi-iui">
            {program === null ? null : (
                <Renderer
                    response={program}
                    library={library}
                    isStreaming={false}
                    onAction={onAction}
                    onError={setErrors}
                    initialState={kept}
                    onStateUpdate={(state) => post({ type: "iui-state", state })}
                />
            )}
            {errors.length > 0 && (
                <details className="pi-iui-errors">
                    <summary>
                        {errors.length === 1 ? "1 problem" : `${errors.length} problems`} in this answer's program
                    </summary>
                    <ul>
                        {errors.map((error, index) => (
                            <li key={index}>
                                {error.code}: {error.message}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<Answer />);

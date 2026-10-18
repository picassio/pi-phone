// For test/openui.test.ts: Open Intelligent UI's library, rendered to HTML in Node (its stylesheets left out), so a
// program can be checked without a browser: it parses, its components evaluate, and nothing throws.
import { Renderer, type OpenUIError } from "@openuidev/react-lang";
import { renderToString } from "react-dom/server";
import { library } from "../../third_party/open-intelligent-ui/lib/library";

export function render(program: string, initialState?: Record<string, unknown>): { html: string; errors: string[] } {
    const errors: string[] = [];
    const html = renderToString(
        <Renderer response={program} library={library} isStreaming={false} initialState={initialState} onError={(list: OpenUIError[]) => errors.push(...list.map((each) => `${each.code}: ${each.message}`))} />,
    );

    return { html, errors };
}

/**
 * The same, mounted in a page (linkedom stands one in): React's effects run, so what was kept (`initialState`) is
 * filled in, and changes reach `onState`. Returns the page's text after the effects, and a way to press a button.
 */
export async function mount(
    program: string,
    initialState: Record<string, unknown> | undefined,
    onState: (state: Record<string, unknown>) => void,
): Promise<{ text: () => string; press: (label: string) => Promise<void>; unmount: () => void }> {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const element = document.createElement("div");

    document.body.appendChild(element);
    const root = createRoot(element);

    await act(async () => {
        root.render(<Renderer response={program} library={library} isStreaming={false} initialState={initialState} onStateUpdate={onState} />);
    });

    return {
        text: () => element.textContent ?? "",
        press: async (label) => {
            const button = [...element.querySelectorAll("button")].find((each) => each.getAttribute("aria-label") === label);

            if (!button) {
                throw new Error(`No button "${label}"`);
            }

            await act(async () => {
                button.dispatchEvent(new window.Event("click", { bubbles: true }));
            });
        },
        unmount: () => root.unmount(),
    };
}

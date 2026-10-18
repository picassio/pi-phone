// For test/openui.test.ts: Open Intelligent UI's library, rendered to HTML in Node (its stylesheets left out), so a
// program can be checked without a browser: it parses, its components evaluate, and nothing throws.
import { Renderer, type OpenUIError } from "@openuidev/react-lang";
import { renderToString } from "react-dom/server";
import { library } from "../../third_party/open-intelligent-ui/lib/library";

export function render(program: string): { html: string; errors: string[] } {
    const errors: string[] = [];
    const html = renderToString(
        <Renderer response={program} library={library} isStreaming={false} onError={(list: OpenUIError[]) => errors.push(...list.map((each) => `${each.code}: ${each.message}`))} />,
    );

    return { html, errors };
}

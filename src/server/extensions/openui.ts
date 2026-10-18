/**
 * Interactive answers (Open Intelligent UI): a program in OpenUI Lang 1.0, drawn by the Intelligent UI frame with its
 * component library: maps with routes, photos, charts, inputs bound to state, calculators, flashcards, 59 functions. Pi
 * writes one in a ```openui block in its reply, or as an `openui` artifact; a button's `@ToAssistant` comes back to Pi
 * as a message. The language's guide (Open Intelligent UI's system prompt, about 8,500 tokens) is not in every prompt:
 * `openui_guide` gives it, once a session, when Pi decides an answer is better used than read.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";

/** In every prompt while the module is on: when to answer this way. */
export const WHEN = `Interactive answers: when an answer is better used than read (a trip or day plan with a map and photos, a calculator or a comparison someone adjusts, a dashboard, a checklist, a quiz or flashcards, step-by-step instructions to tick off), answer with a program in OpenUI Lang, drawn as a working UI in the chat. Call openui_guide first (once per session) for the language and its components, then put the program in a fenced block with the language openui, with a sentence or two of Markdown around it. For a large one the person will come back to, publish it as an artifact of type openui instead. A button's @ToAssistant comes back to you as the person's message. Plain questions still get plain answers.`;

/** How the guide below applies in pi-phone, ahead of it. */
const IN_PI_PHONE = `# OpenUI Lang in pi-phone

The guide below is Open Intelligent UI's system prompt. It is written for answers that are only a program. In pi-phone:
- Put the program in a fenced code block whose language is openui. Outside the block, write ordinary Markdown (a short lead-in, a note); inside it, follow the guide exactly: statements only, root = Col(...) first.
- For a larger answer, publish it with the artifact tool, type "openui", the program as its content.
- One program per block. It is drawn once your reply is complete; while you write, the person sees its code.
- @ToAssistant sends its message, with any form values and context, to you as the person's next message. Use it for what the page cannot compute.
- @OpenUrl opens a link; @CopyToClipboard copies.
- SearchImage finds photos on Wikipedia and Wikimedia Commons; Map draws OpenStreetMap tiles and street routes between stops. Both need the network, which the phone has.
- There are no data tools (Query) here.

---

`;

const GUIDE_FILE = join(APP_ROOT, "third_party", "open-intelligent-ui", "system-prompt.txt");

export default function createOpenUi(_host: PocketHost) {
    // Read as the module loads: a runtime without it fails here, saying so, not at Pi's first call.
    const guide = IN_PI_PHONE + readFileSync(GUIDE_FILE, "utf8");

    const openuiGuide = defineTool({
        name: "openui_guide",
        description:
            "The guide to OpenUI Lang and the Intelligent UI components (layout, text, inputs with state, charts, tables, maps, photos, math, SVG, functions, actions): read it once per session before writing an interactive answer.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ output: [{ type: "text" as const, text: guide }] }),
    });

    return defineExtension({
        name: "pocket-openui",
        tools: [openuiGuide],
        sections: [section("interactive_answers", () => WHEN)],
    });
}

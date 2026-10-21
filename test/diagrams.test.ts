// Mermaid diagrams in replies, wiki pages, and interview questions: pele (MIT, obsidianmd/pele) draws them in the
// browser from /vendor/pele.mjs. Here: that file is served, and draws the kinds Pi writes, safely.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { render } from "pele";
import { VENDOR } from "../src/server/http/assets.ts";

test("pele is served to the web app as one module, and the import map names it", () => {
    const file = VENDOR["pele.mjs"]!;

    assert.ok(existsSync(file), file);
    assert.doesNotMatch(readFileSync(file, "utf8"), /^import |\bfrom "\.\//m, "no imports of its own");
    assert.match(readFileSync(new URL("../web/index.html", import.meta.url), "utf8"), /"pele": "\.\/vendor\/pele\.mjs"/);
});

test("pele draws flowcharts, sequences, and charts as SVG without scripts, and says where a diagram is wrong", () => {
    for (const source of [
        "flowchart LR\n  A[Phone] -->|ssh| B(Machine)\n  B --> C{Ready?}",
        "sequenceDiagram\n  Pi->>Phone: secret_request\n  Phone-->>Pi: saved",
        'pie title Spend\n  "Claude" : 70\n  "OpenRouter" : 30',
        'xychart\n  x-axis [mon, tue, wed]\n  bar [3, 5, 2]',
    ]) {
        const { svg } = render(source, { links: false });

        assert.match(svg, /^<svg [^>]*class="pele /, source);
        assert.doesNotMatch(svg, /<script|on\w+=/i, source);
    }

    assert.throws(() => render("flowchart LR\n A -->"), (error: Error & { line?: number }) => error.name === "PeleError" && error.line === 3);
    // Text is text: a label cannot become markup.
    assert.doesNotMatch(render('flowchart LR\n  A["<img src=x onerror=alert(1)>"]').svg, /<img/);
});

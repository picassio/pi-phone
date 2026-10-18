// Math in Markdown (web/math.js): TeX becomes placeholders KaTeX draws in the browser; prices, code, and broken TeX do
// not. Here: the placeholders marked makes, and that KaTeX is served and draws them.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import katex from "katex";
import { Marked } from "marked";
import { katexFile } from "../src/server/http/assets.ts";
import { mathExtension } from "../web/math.js";

const markdown = new Marked({ gfm: true }).use(mathExtension);
const render = (text: string) => markdown.parse(text, { async: false }) as string;
const placeholders = (html: string) => [...html.matchAll(/<code data-math="(\w+)">([^<]*)<\/code>/g)].map((match) => [match[1], match[2]]);

test("TeX inline and on its own becomes placeholders; prices and code stay text", () => {
    assert.deepEqual(placeholders(render("Energy is $E = mc^2$, and \\(a_i\\) too.")), [["inline", "E = mc^2"], ["inline", "a_i"]]);
    assert.deepEqual(placeholders(render("$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$")), [["display", "\\int_0^1 x^2\\,dx = \\frac{1}{3}"]]);
    assert.deepEqual(placeholders(render("\\[\na^2 + b^2 = c^2\n\\]")), [["display", "a^2 + b^2 = c^2"]]);
    assert.deepEqual(placeholders(render("Between $$x$$ words")), [["display", "x"]]);
    assert.match(render("a $$x$$ b"), /^<p>a <code data-math="display">x<\/code> b<\/p>/, "inside a sentence, it stays there");

    // Prices, a lone dollar, shell variables in code: text.
    for (const text of ["It costs $5 and $10.", "Pay $5, then $ 3", "Run `echo $HOME $PATH`", "```sh\necho \"$A\" \"$B\"\n```", "From $3 to $4 a month"]) {
        assert.deepEqual(placeholders(render(text)), [], text);
    }

    // Underscores in TeX are not emphasis, and markup in it is escaped.
    assert.deepEqual(placeholders(render("$a_1 + b_2$ and $x<y$")), [["inline", "a_1 + b_2"], ["inline", "x&lt;y"]]);
});

test("KaTeX is served from its package, and draws without HTML from the TeX", () => {
    for (const parts of [["katex.mjs"], ["katex.min.css"], ["fonts", "KaTeX_Main-Regular.woff2"]]) {
        const file = katexFile(parts);

        assert.ok(file !== undefined && existsSync(file), parts.join("/"));
    }

    assert.equal(katexFile(["..", "package.json"]), undefined);
    assert.equal(katexFile(["fonts", "KaTeX_Main-Regular.ttf"]), undefined, "woff2 only");
    assert.match(katex.renderToString("\\frac{1}{2}", { throwOnError: false, trust: false }), /class="katex"/);
    assert.doesNotMatch(katex.renderToString("\\href{javascript:alert(1)}{x}", { throwOnError: false, trust: false }), /href="javascript/, "no link from TeX");
    assert.match(katex.renderToString("\\frac{1}{", { throwOnError: false }), /katex-error/, "broken TeX is shown, not thrown");
});

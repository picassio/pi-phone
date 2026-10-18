// Math in Markdown: a marked extension that leaves placeholders, and KaTeX (MIT), loaded the first time math shows, to
// draw them. Apart from ui.js so the rules for dollar signs can be tested without a browser.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * Math, as Pi writes it: dollar-delimited TeX inline (one dollar each side, or a backslash-paren pair), and display math
 * on its own (two dollars each side, or a backslash-bracket pair). Each becomes a placeholder, a `code` element with
 * `data-math` ("inline" or "display") holding the TeX as text, which `Markdown` draws with KaTeX once it has loaded. A
 * single dollar follows pandoc's rule, so prices stay text ("$5 and $10"): it opens before a non-space, closes after
 * one, and not before a digit. Code, inline or fenced, is never math.
 */
const mathPlaceholder = (tex, display) =>
    `<code data-math="${display ? "display" : "inline"}">${escapeHtml(tex)}</code>`;

export const mathExtension = {
    extensions: [
        {
            name: "mathBlock",
            level: "block",
            // Only at the start of a line: display math inside a sentence stays in it (the inline rule).
            start: (src) => {
                const found = /(^|\n)(?=\$\$|\\\[)/.exec(src);

                return found ? found.index + found[1].length : undefined;
            },
            tokenizer(src) {
                const found = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);

                return found ? { type: "mathBlock", raw: found[0], text: (found[1] ?? found[2]).trim() } : undefined;
            },
            renderer: (token) => `<div>${mathPlaceholder(token.text, true)}</div>\n`,
        },
        {
            name: "mathInline",
            level: "inline",
            start: (src) => src.match(/\$|\\\(/)?.index,
            tokenizer(src) {
                const found =
                    /^\$\$([^$]+?)\$\$/.exec(src) ??
                    /^\\\(([\s\S]+?)\\\)/.exec(src) ??
                    /^\$(?=\S)((?:\\\$|[^$\n])*?\S)\$(?!\d)/.exec(src);

                if (!found) {
                    return undefined;
                }

                return { type: "mathInline", raw: found[0], text: found[1], display: found[0].startsWith("$$") };
            },
            renderer: (token) => mathPlaceholder(token.text, token.display),
        },
    ],
};

/** KaTeX, loaded with its stylesheet the first time math shows: 0.3 MB nobody needs before then. */
let katex = null;

function loadKatex() {
    if (katex === null) {
        const sheet = document.createElement("link");

        sheet.rel = "stylesheet";
        sheet.href = "/vendor/katex/katex.min.css";
        document.head.append(sheet);
        katex = import("/vendor/katex/katex.mjs").then((module) => module.default);
    }

    return katex;
}

/**
 * Draw the math placeholders under `root` (the math extension above) with KaTeX: no HTML from the TeX (`trust` off),
 * and an error drawn in place rather than thrown. A drawn one stays: Preact leaves unchanged HTML alone.
 */
export function drawMath(root) {
    const waiting = root?.querySelectorAll("code[data-math]:not([data-drawn])");

    if (!waiting || waiting.length === 0) {
        return;
    }

    loadKatex().then(
        (engine) => {
            for (const placeholder of waiting) {
                if (!placeholder.isConnected) {
                    continue;
                }

                const display = placeholder.dataset.math === "display";
                const drawn = document.createElement(display ? "div" : "span");

                drawn.className = display ? "math math-display" : "math";
                engine.render(placeholder.textContent ?? "", drawn, {
                    displayMode: display,
                    throwOnError: false,
                    trust: false,
                    strict: "ignore",
                    output: "htmlAndMathml",
                });
                placeholder.setAttribute("data-drawn", "");
                placeholder.replaceWith(drawn);
            }
        },
        (error) => console.error("KaTeX did not load", error),
    );
}


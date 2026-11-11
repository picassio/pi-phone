// Code's syntax colours in a dark palette, readable on code's ground (PP-406). style.css draws each `--hl-*` in one of
// the palette's colours; some palettes' are too dark for their code blocks (miasma's #685742 on #191919 is 2.54:1,
// solitude's and matte-black's under 4.5:1 too). Those, and only those, are lifted toward white in oklab, a percent at
// a time, until they read at 4.5:1 (WCAG AA); the rest keep the palette's colour. A light palette darkens its code
// colours in style.css instead.

/** Each syntax token and the palette variable style.css draws it in. */
export const SYNTAX = {
    "--hl-kw": "--o-magenta",
    "--hl-str": "--o-green",
    "--hl-num": "--o-orange",
    "--hl-fn": "--o-blue",
    "--hl-type": "--o-yellow",
    "--hl-op": "--o-cyan",
    "--hl-tag": "--o-red",
};

/** The contrast code's words need on their ground. */
export const CODE_CONTRAST = 4.5;

const channels = (hex) => {
    const six = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1, 7);

    return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16) / 255);
};
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (rgb) => {
    const [r, g, b] = rgb.map(toLinear);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG's contrast between two sRGB colours (channels 0 to 1). */
export const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];

    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

function oklab(rgb) {
    const [r, g, b] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) =>
        Math.min(1, Math.max(0, fromLinear(c))),
    );
}

const hexOf = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
const WHITE = oklab([1, 1, 1]);

/**
 * The `--hl-*` colours a dark palette's variables (`themeVars`) need lifted to read on code's ground (`--o-bg-dark`):
 * token to colour, for those under 4.5:1 only.
 */
export function readableCode(vars) {
    const ground = channels(vars["--o-bg-dark"]);
    const lifted = {};

    for (const [token, source] of Object.entries(SYNTAX)) {
        const ink = channels(vars[source]);

        if (contrast(ink, ground) >= CODE_CONTRAST) {
            continue;
        }

        const from = oklab(ink);
        let share = 0;
        let mixed = ink;

        // Measured as drawn, in whole 8-bit channels; white is as far as it goes.
        while (share < 1 && contrast(mixed, ground) < CODE_CONTRAST) {
            share = Math.min(1, share + 0.01);
            mixed = channels(hexOf(fromOklab(from.map((v, i) => v * (1 - share) + WHITE[i] * share))));
        }

        lifted[token] = hexOf(mixed);
    }

    return lifted;
}

// The app's quieter text tokens read on its surfaces with every palette that comes with it (PP-399, the owner's rule):
// words at 4.5:1 or more (WCAG AA), hints at 3:1 or more. The mixes are read from web/style.css, so a change there is
// held to it; the colors are mixed as the browser does (`color-mix` in oklab or srgb).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";

type Rgb = [number, number, number];
type Colors = Record<string, string>;

const web = join(APP_ROOT, "web");
const { THEMES } = (await import(join(web, "themes.js"))) as { THEMES: Record<string, { colors: Colors }> };
const css = readFileSync(join(web, "style.css"), "utf8");
const light = /:root\[data-mode="light"\] \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const root = /\n:root \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

/** A token's share in `color-mix(in oklab, var(<of>) N%, <to>)`, from a block of style.css. */
function share(block: string, token: string): number {
    const match = new RegExp(`${token}: color-mix\\(in oklab, var\\(--[a-z-]+\\) (\\d+)%`).exec(block);
    assert.ok(match, `${token} is a color-mix in oklab`);

    return Number(match[1]) / 100;
}

const value = (block: string, token: string) => new RegExp(`${token}: ([^;]+);`).exec(block)?.[1]?.trim();

const hex = (h: string): Rgb => {
    const six = h.replace("#", "").length === 3 ? [...h.replace("#", "")].map((c) => c + c).join("") : h.replace("#", "");

    return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16) / 255) as Rgb;
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const unlin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(rgb: Rgb): Rgb {
    const [r, g, b] = rgb.map(lin) as Rgb;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, A, B]: Rgb): Rgb {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) =>
        Math.min(1, Math.max(0, unlin(c))),
    ) as Rgb;
}

const mixOklab = (a: Rgb, b: Rgb, p: number): Rgb => {
    const [x, y] = [oklab(a), oklab(b)];

    return fromOklab(x.map((v, i) => v * p + y[i]! * (1 - p)) as Rgb);
};
const mixSrgb = (a: Rgb, b: Rgb, p: number): Rgb => a.map((v, i) => v * p + b[i]! * (1 - p)) as Rgb;
const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map(lin) as Rgb;

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
    const [x, y] = [luminance(a), luminance(b)];

    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Each palette's ground, cards, a raised segment and a selected row (the accent's 14 % tint), as style.css mixes them. */
function surfaces(c: Colors): Record<string, Rgb> {
    const bg = hex(c.background!);
    const body = hex(c.foreground!);

    return {
        ground: bg,
        card: mixSrgb(body, bg, 0.04),
        "card-2": mixSrgb(body, bg, 0.08),
        raised: mixSrgb(body, bg, 0.12),
        selected: mixSrgb(hex(c.accent ?? c.blue!), bg, 0.14),
    };
}

/** Where `ink` reads under `needs` on one of `on`: "<palette> <token> on <surface>: <ratio>". */
function under(palette: string, token: string, ink: Rgb, on: Record<string, Rgb>, needs: number): string[] {
    return Object.entries(on)
        .filter(([, ground]) => ratio(ink, ground) < needs - 0.005)
        .map(([name, ground]) => `${palette} ${token} on ${name}: ${ratio(ink, ground).toFixed(2)}`);
}

const palettes = Object.entries(THEMES).map(([id, { colors }]) => ({ id, colors, light: colors.mode === "light" }));

test("muted words read at 4.5:1 and faint hints at 3:1 on every surface, with every palette", () => {
    assert.ok(palettes.length >= 20 && palettes.some((each) => each.light));
    const low = palettes.flatMap(({ id, colors, light: isLight }) => {
        const bg = hex(colors.background!);
        const body = hex(colors.foreground!);
        const block = isLight ? light : root;

        return [
            ...under(id, "--muted", mixOklab(body, bg, share(block, "--muted")), surfaces(colors), 4.5),
            ...under(id, "--faint", mixOklab(body, bg, share(block, "--faint")), surfaces(colors), 3),
        ];
    });

    assert.deepEqual(low, []);
});

test("light palettes: the accent as words, and code's colors, read at 4.5:1", () => {
    const accentShare = share(light, "--accent");
    const low = palettes
        .filter((each) => each.light)
        .flatMap(({ id, colors }) => {
            const code = hex(colors.dark_background ?? colors.background!);
            const hl = { "--hl-kw": colors.magenta, "--hl-str": colors.green, "--hl-num": colors.orange ?? colors.bright_yellow ?? colors.yellow, "--hl-fn": colors.blue ?? colors.accent, "--hl-type": colors.yellow, "--hl-op": colors.cyan, "--hl-tag": colors.red };

            return [
                ...under(id, "--accent", mixOklab(hex(colors.accent ?? colors.blue!), [0, 0, 0], accentShare), surfaces(colors), 4.5),
                ...Object.entries(hl).flatMap(([token, color]) => under(id, token, mixOklab(hex(color!), [0, 0, 0], share(light, token)), { code }, 4.5)),
            ];
        });

    assert.equal(value(light, "--accent")?.endsWith("#000)"), true, "the light accent darkens toward black");
    assert.deepEqual(low, []);
});

/**
 * A dark palette's code colors (PP-406): each `--hl-*` in its palette color, as `themeVars` picks it, on code's ground
 * (`--o-bg-dark`), or lifted by web/code-ink.js where that reads under 4.5:1 (miasma, solitude and matte-black did).
 */
test("dark palettes: code's colors read at 4.5:1 on code's ground, and those that read already keep the palette's color", async () => {
    const { readableCode, SYNTAX } = (await import(join(web, "code-ink.js"))) as { readableCode: (vars: Colors) => Colors; SYNTAX: Colors };
    const kept: string[] = [];
    const low = palettes
        .filter((each) => !each.light)
        .flatMap(({ id, colors }) => {
            const vars: Colors = {
                "--o-bg-dark": colors.dark_background ?? colors.background!,
                "--o-magenta": colors.magenta ?? "#bb9af7",
                "--o-green": colors.green ?? "#9ece6a",
                "--o-orange": colors.orange ?? colors.bright_yellow ?? colors.yellow ?? "#ff9e64",
                "--o-blue": colors.blue ?? colors.accent!,
                "--o-yellow": colors.yellow ?? colors.bright_yellow ?? "#e0af68",
                "--o-cyan": colors.cyan ?? "#7dcfff",
                "--o-red": colors.red ?? "#f7768e",
            };
            const lifted = readableCode(vars);
            const code = hex(vars["--o-bg-dark"]!);

            for (const [token, source] of Object.entries(SYNTAX)) {
                if (lifted[token] === undefined) {
                    kept.push(`${id} ${token}`);
                } else {
                    assert.ok(ratio(hex(vars[source]!), code) < 4.5, `${id} ${token} is lifted only when it reads under 4.5:1`);
                }
            }

            return Object.entries(SYNTAX).flatMap(([token, source]) => under(id, token, hex(lifted[token] ?? vars[source]!), { code }, 4.5));
        });

    assert.deepEqual(low, []);
    assert.ok(kept.length > 100, `most keep their color: ${kept.length}`);
});

test("words in a color on its tint (initials, a column's count) read at 4.5:1, with every palette", () => {
    const low = palettes.flatMap(({ id, colors, light: isLight }) => {
        const block = isLight ? light : root;
        const toward = hex(value(block, "--tint-ink-toward")!);
        const inkShare = Number(value(block, "--tint-ink-share")!.replace("%", "")) / 100;
        const bg = hex(colors.background!);
        const card = mixSrgb(hex(colors.foreground!), bg, 0.04);

        // web/avatar.js's COLORS: the palette's hues and its bright foreground.
        return ["blue", "green", "yellow", "magenta", "cyan", "red", "orange", "bright_foreground"].flatMap((name) => {
            const who = hex(colors[name] ?? colors.accent!);

            return under(id, `initials in ${name}`, mixOklab(who, toward, inkShare), { tint: mixSrgb(who, bg, 0.2), "tint on a card": mixSrgb(who, card, 0.2) }, 4.5);
        });
    });

    assert.deepEqual(low, []);
});

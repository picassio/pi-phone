/**
 * Draws pi-phone's raster icons from web/icon.svg (resvg, which this script loads from RESVG, a folder where
 * `@resvg/resvg-js` is installed: it is not a dependency of the app):
 *
 *   RESVG=$TMPDIR/resvg node scripts/icons.ts
 *
 * web/apple-touch-icon.png (180), web/icon-192.png, web/icon-512.png, web/icon-maskable-512.png (the mark shrunk to
 * the maskable safe zone, the tile full bleed), and Android's legacy launcher icon (192, xxxhdpi). Android 8 and later
 * use the adaptive icon instead, whose vector layers repeat the SVG's paths.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const folder = process.env.RESVG;

if (folder === undefined) {
    throw new Error("Set RESVG to a folder where @resvg/resvg-js is installed.");
}

const { Resvg } = createRequire(join(folder, "package.json"))("@resvg/resvg-js") as {
    Resvg: new (svg: string, options: object) => { render(): { asPng(): Buffer } };
};
const svg = readFileSync(join(ROOT, "web", "icon.svg"), "utf8");
// Maskable: the mark within the inner 80% circle, the tile to the edges.
const maskable = svg.replace('<g id="mark" transform="translate(-29 -24)">', '<g id="mark" transform="translate(256 256) scale(0.8) translate(-256 -256) translate(-29 -24)">');

if (maskable === svg) {
    throw new Error("web/icon.svg has no mark group to shrink");
}

const draw = (source: string, size: number, to: string) => {
    writeFileSync(join(ROOT, to), new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng());
    console.log(`${to} (${size})`);
};

draw(svg, 180, "web/apple-touch-icon.png");
draw(svg, 192, "web/icon-192.png");
draw(svg, 512, "web/icon-512.png");
draw(maskable, 512, "web/icon-maskable-512.png");
draw(svg, 192, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png");

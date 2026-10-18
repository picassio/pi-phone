/**
 * Build the frame that draws interactive answers (src/frames/intelligent-ui.tsx, with Open Intelligent UI's library from
 * third_party/) into web/vendor/intelligent-ui/: `frame.js` and its chunks (ES modules, split so the map, the icons, and
 * KaTeX load only when an answer uses them), `frame.css` with the fonts it names, and `maplibre-worker.js`, MapLibre's
 * worker as one module with no imports, which the frame starts from a Blob URL. Run in CI before the runtime is
 * packaged, and by the tests; the output is not committed.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "web", "vendor", "intelligent-ui");

export async function buildIntelligentUi(): Promise<void> {
    rmSync(OUT, { recursive: true, force: true });

    await build({
        absWorkingDir: ROOT,
        entryPoints: { frame: "src/frames/intelligent-ui.tsx" },
        outdir: OUT,
        bundle: true,
        format: "esm",
        splitting: true,
        minify: true,
        target: "es2022",
        jsx: "automatic",
        chunkNames: "chunks/[name]-[hash]",
        assetNames: "assets/[name]-[hash]",
        loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
        // The library was written for Next.js: no base path, a production build.
        define: { "process.env.NEXT_PUBLIC_BASE_PATH": "undefined", "process.env.NODE_ENV": '"production"' },
        legalComments: "linked",
        logLevel: "warning",
    });

    await build({
        absWorkingDir: ROOT,
        entryPoints: { "maplibre-worker": "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs" },
        outdir: OUT,
        bundle: true,
        format: "esm",
        minify: true,
        target: "es2022",
        legalComments: "linked",
        logLevel: "warning",
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await buildIntelligentUi();
    console.log(`Built ${OUT}`);
}

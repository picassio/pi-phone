// The server edition image's smoke test (deploy/smoke.sh runs it inside a fresh container, as CI does): Pi's browser opens
// a site and switches to desktop, and the screenshot renderer pictures the app's own page, signed in, at phone and
// desktop widths with a clean layout check. Exits non-zero when any of it fails.
import { readFileSync } from "node:fs";
import { ChromeEngine, PiBrowser } from "/app/src/server/browser/pi-browser.ts";
import { ChromeRenderer } from "/app/src/server/chrome-renderer.ts";
import { Screenshots } from "/app/src/server/screenshots.ts";

const chrome = `/app/native/linux-${process.arch === "arm64" ? "arm64" : "x64"}/chrome/chrome-headless-shell`;
const engine = new ChromeEngine(chrome, ["--no-sandbox"], { profile: "/data/home/.pi/mobile/browser-smoke" });
const browser = new PiBrowser({ engine, place: "phone", session: 1, changed: () => {}, frame: () => {}, log: console.error });

console.log("BROWSER", (await browser.open(1, "https://example.com")).split("\n")[0]);
console.log("DESKTOP", (await browser.resize(1, "desktop")).split("\n")[0]);
await browser.close();
await engine.close();

const token = (JSON.parse(readFileSync("/data/pocket/config.json", "utf8")) as { ownerToken: string }).ownerToken;
const screenshots = new Screenshots();
const renderer = new ChromeRenderer(screenshots, { binary: chrome, flags: ["--no-sandbox"], base: "http://127.0.0.1:8787", token: () => token, log: console.error });
void renderer.run();
await new Promise((resolve) => setTimeout(resolve, 300));

const shots = await screenshots.render("http://127.0.0.1:8787/", { widths: [390, 1280], settleMs: 3000 });

for (const shot of shots) {
    console.log("SHOT", shot.width, shot.height, shot.parts.length, "parts", shot.parts[0]!.length, "bytes", JSON.stringify(shot.layout?.issues ?? "no check"));
    if (shot.layout === undefined || shot.layout.issues.length > 0 || shot.parts[0]!.length < 2000) {
        console.error("SHOT FAILED", shot.width);
        process.exit(1);
    }
}

await renderer.stop();
process.exit(0);

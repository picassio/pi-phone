// A process that starts a Chrome through `ChromeEngine` and ends without closing it, as a test that fails before its
// cleanup does (Build APK #347): it must still exit, and take its Chrome with it. argv[2]: the Chrome to start.
import { ChromeEngine } from "../../src/server/browser/pi-browser.ts";

const engine = new ChromeEngine(process.argv[2]!);

// A failure is said, not thrown: as node:test does, the process then ends only when nothing keeps it running.
try {
    process.stdout.write(`tab ${await engine.newTab()}\n`);
} catch (error) {
    process.stdout.write(`failed: ${String(error)}\n`);
}

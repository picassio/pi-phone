// A stand-in for Chrome as `ChromeEngine` starts it (Build APK #347): it makes its DevToolsActivePort empty first, as
// Chrome does, and writes the port a moment later (FAKE_CHROME_WRITE_MS), then answers DevTools' HTTP: a new tab is
// "fake-tab", and no tab is listed. It runs until it is killed, writing its pid to FAKE_CHROME_PIDFILE.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const profile = process.argv.find((each) => each.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);

if (profile === undefined) {
    process.exit(2);
}

if (process.env.FAKE_CHROME_PIDFILE !== undefined) {
    writeFileSync(process.env.FAKE_CHROME_PIDFILE, String(process.pid));
}

const file = join(profile, "DevToolsActivePort");

writeFileSync(file, "");
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CHROME_WRITE_MS ?? 400)));

const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.startsWith("/json/new") ? { id: "fake-tab", type: "page", url: "about:blank" } : []));
});

server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };

    writeFileSync(file, `${port}\n/devtools/browser/fake\n`);
});

// Pi's machine_add card in a real browser (PP-139), against a real sshd on loopback: the card shows the machine's name,
// address, key and host key (matched with the one Pi read), fits a phone's column, and Approve and connect adds the
// machine, which the New session folder picker lists at once, without a reload. With MACHINE_SHOTS set to a folder,
// screenshots at 390 and 1280 px go there.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : sshdPath === undefined ? "no sshd on this machine" : false;
const SHOTS = process.env.MACHINE_SHOTS;
let toolArgs: Record<string, unknown> = {};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("add the vm")) {
        return fauxAssistantMessage([fauxToolCall("machine_add", toolArgs as never)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let sshd: ChildProcess | undefined;
let base = "";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createNetServer();

        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number };

            probe.close(() => resolve(port));
        });
        probe.on("error", reject);
    });
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

before(async () => {
    if (skip) {
        return;
    }

    const etc = join(root, "machine-ui-etc");
    const authorized = join(root, "machine-ui-remote", ".ssh", "authorized_keys");
    const port = await freePort();

    mkdirSync(etc, { recursive: true });
    mkdirSync(join(root, "machine-ui-remote", ".ssh"), { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
    writeFileSync(
        join(etc, "sshd_config"),
        `${[`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(etc, "host_key")}`, `AuthorizedKeysFile ${authorized}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "StrictModes no", "UsePAM no", `PidFile ${join(etc, "sshd.pid")}`, "LogLevel ERROR"].join("\n")}\n`,
    );
    sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    await until(() => existsSync(join(etc, "sshd.pid")), "sshd listens");

    app = await openApp(scriptedModel(route), join(root, "machine-ui-data"));
    const key = await app.sshKeys.generate("sandbox-key");

    writeFileSync(authorized, `${key.publicKey}\n`, { mode: 0o600 });
    toolArgs = {
        name: "tuanlh-sandbox-01",
        address: `${userInfo().username}@127.0.0.1:${port}`,
        key: "sandbox-key",
        expectedFingerprint: execFileSync("ssh-keygen", ["-lf", join(etc, "host_key.pub")], { encoding: "utf8" }).split(/\s+/)[1],
        reason: "The VM I just built on han-proxmox, for the sandbox work",
    };
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "machine-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    sshd?.kill();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

test("the machine_add card shows the machine, fits a phone, and Approve adds it to the folder picker at once", { skip }, async () => {
    const id = await newSession(app);

    await app.commands.submit(id as never, owner(app), { text: "add the vm", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id as never).length > 0, "the card");

    // On a phone: the card in the column, nothing wider than the screen.
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".machine-add-card")) !== "", "the card on a phone");
    const card = await text(".machine-add-card");

    assert.match(card, /Add tuanlh-sandbox-01 to your machines\?/);
    assert.match(card, /The VM I just built on han-proxmox/);
    assert.ok(card.includes(String(toolArgs.address)), card);
    assert.match(card, /sandbox-key\s+SHA256:/);
    assert.match(card, /SHA256:\S+ \(ED25519\)/);
    assert.match(card, /the one Pi read on the machine itself/);
    assert.match(card, /installs pi-env there \(about 2 MB, in ~\/\.pi\/mobile\/tools\) and connects\. Deny saves nothing\./);
    // The machine tools, ticked (PP-177): Computer use among them, needing a desktop session on Linux.
    assert.match(card, /Also install there/);
    // The version is the one machine-tools.ts pins (test/machine-tools-ocu.test.ts checks the pin itself).
    assert.match(card, /Computer use \(ocu\) \d+\.\d+\.\d+-pp\.\d+ · about 2\.5 MB · needs a desktop session on Linux/);
    // ffmpeg and HyperFrames (PP-246) are listed but not ticked: they are big.
    assert.match(card, /ffmpeg \d+\.\d+\.\d+ · about 350 MB/);
    assert.match(card, /HyperFrames \d+\.\d+\.\d+ · about 320 MB; with Chrome and ffmpeg about 920 MB/);
    assert.deepEqual(
        await inPage<boolean[]>(`return JSON.stringify([...document.querySelectorAll(".machine-add-card .machine-tool input")].map((each) => each.checked))`),
        [true, true, true, true, true, false, false],
    );
    const fits = await inPage<{ card: number; column: number; page: number; screen: number }>(`
        const card = document.querySelector(".machine-add-card").getBoundingClientRect();
        const column = document.querySelector(".machine-add-card").parentElement.getBoundingClientRect();

        return JSON.stringify({ card: card.right, column: column.right, page: document.documentElement.scrollWidth, screen: innerWidth });
    `);

    assert.ok(fits.card <= fits.column + 1 && fits.page <= fits.screen, JSON.stringify(fits));
    await shot("machine-add-390");

    // On a desktop, Approve and connect; the folder picker of a new session lists it without a reload.
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".machine-add-card")) !== "", "the card on a desktop");
    await shot("machine-add-1280");
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".machine-add-card .button.primary")?.disabled === false)`), "Approve enabled");
    // Nothing to download here: every tool unticked.
    await page.evaluate(`for (const box of document.querySelectorAll(".machine-add-card .machine-tool input")) if (box.checked) box.click()`);
    await page.click({ selector: ".machine-add-card .button.primary" });
    await until(() => app.machines.list().some((each) => each.name === "tuanlh-sandbox-01" && each.remote !== undefined), "connected", 60_000);
    await until(async () => (await text(".machine-add-card")) === "", "the card gone");
    await page.click({ selector: ".new-button" });
    await until(async () => (await text(".fp-places")).includes("tuanlh-sandbox-01"), "the machine in the folder picker");
    await shot("machine-add-picker-1280");
});

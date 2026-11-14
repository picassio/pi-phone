// A machine's changed host key in a real browser (PP-509), against a real sshd on loopback whose key the test changes as
// a reboot does: the Machines sheet's row says its host key changed and offers to compare the key it presents with the
// one accepted before; Replace key keeps it connected, and the row and a session's dock in another tab clear at once.
// The owner's path before (Forget, Scan, Accept, Install and connect) leaves no error from before on the row either.
// With PHONE_SHOTS set to a folder, screenshots and layout reports at 390, 1280 and 1920 px go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const sshdPath = ["/usr/sbin/sshd", join(process.env.PREFIX ?? "/usr", "bin", "sshd")].find((path) => existsSync(path));
const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : sshdPath === undefined ? "no sshd on this machine" : false;
const SHOTS = process.env.PHONE_SHOTS;
const WIDE = { width: 1920, height: 1080, scale: 1, mobile: false };
const etc = join(root, "rekey-ui-etc");
// The machine's home is the test's: what pi-phone puts there never reaches the real one.
const remoteHome = join(root, "rekey-ui-remote");
const tools = join(remoteHome, ".pi", "mobile", "tools");
let app: App;
let server: Server;
let browsers: Browsers;
let sheet: BrowserPage;
let dock: BrowserPage;
let sshd: ChildProcess | undefined;
let base = "";
let machineId = "";
/** The fingerprint Pi reads on the machine itself, for machine_rekey. */
let readThere = "";

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("replace the devbox key")) {
        return fauxAssistantMessage(
            [fauxToolCall("machine_rekey", { machine: "tuanlh-devbox-01", expectedFingerprint: readThere, reason: "The VM moved from han-proxmox to tuan-pve and cloud-init made new host keys; I read this one through the guest agent." })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};

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

async function startSshd(): Promise<void> {
    rmSync(join(etc, "sshd.pid"), { force: true });
    sshd = spawn(sshdPath!, ["-D", "-e", "-f", join(etc, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
    await until(() => existsSync(join(etc, "sshd.pid")), "sshd listens");
}

function newHostKey(): void {
    rmSync(join(etc, "host_key"), { force: true });
    rmSync(join(etc, "host_key.pub"), { force: true });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(etc, "host_key")]);
    chmodSync(join(etc, "host_key"), 0o600);
}

/** The machine reboots with a new host key: its sessions and the daemon end, and the same address presents another key. */
async function changeHostKey(): Promise<void> {
    execFileSync("sh", ["-c", `pkill -f '${tools}/[p]i-env' ; pkill -P ${sshd!.pid} ; true`]);
    sshd!.kill();
    await until(() => sshd!.exitCode !== null || sshd!.signalCode !== null, "sshd stops");
    newHostKey();
    await startSshd();
    readThere = execFileSync("ssh-keygen", ["-lf", join(etc, "host_key.pub")], { encoding: "utf8" }).split(/\s+/)[1]!;
}

before(async () => {
    if (skip) {
        return;
    }

    const port = await freePort();

    mkdirSync(etc, { recursive: true });
    mkdirSync(join(remoteHome, ".ssh"), { recursive: true, mode: 0o700 });
    newHostKey();
    app = await openApp(scriptedModel(route), join(root, "rekey-ui-data"));
    const key = await app.sshKeys.generate("devbox-key");

    writeFileSync(join(remoteHome, ".ssh", "authorized_keys"), `${key.publicKey}\n`, { mode: 0o600 });
    writeFileSync(
        join(etc, "sshd_config"),
        `${[`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(etc, "host_key")}`, `AuthorizedKeysFile ${join(remoteHome, ".ssh", "authorized_keys")}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "StrictModes no", "UsePAM no", `PidFile ${join(etc, "sshd.pid")}`, `SetEnv HOME=${remoteHome}`, "LogLevel ERROR"].join("\n")}\n`,
    );
    await startSshd();
    const machine = app.machines.add({ name: "tuanlh-devbox-01", address: `${userInfo().username}@127.0.0.1:${port}`, keyId: key.id });
    const scanned = await app.machines.scan(machine.id);

    await app.machines.accept(machine.id, scanned.lines, scanned.fingerprints[0]);
    await app.machines.connect(machine.id);
    machineId = machine.id;
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "rekey-ui-")), load: async () => undefined, save: () => {} });
    sheet = await browsers.open(1);
    await sheet.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    dock = await browsers.open(2);
    await dock.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(() =>
    cleanUpAll(
        () => sshd?.kill(),
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

const inPage = async <T>(page: BrowserPage, script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const text = (page: BrowserPage, selector: string) => inPage<string>(page, `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);
/** Clicks the row's button with this label. */
const press = (label: string) =>
    sheet.evaluate(`const button = [...document.querySelectorAll(".machine button")].find((each) => each.innerText.trim() === ${JSON.stringify(label)} && !each.disabled); if (!button) throw new Error("no button ${label}"); button.click(); return "true";`);
const hasButton = (label: string) => inPage<boolean>(sheet, `return JSON.stringify([...document.querySelectorAll(".machine button")].some((each) => each.innerText.trim() === ${JSON.stringify(label)} && !each.disabled))`);

async function openMachines(): Promise<void> {
    await sheet.navigate(`${base}/`);
    await until(async () => inPage<boolean>(sheet, `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`), "signed in", 30_000);
    await sheet.evaluate(`(await import("/store.js")).openSheet({ type: "machines" }); return "true";`);
    await until(async () => (await text(sheet, ".machine")) !== "", "the machine's row", 30_000);
}

/** The layout check on the page as it shows at each width (and its picture and words, with PHONE_SHOTS). */
async function checked(name: string, page = sheet): Promise<Record<number, LayoutReport["totals"]>> {
    const totals: Record<number, LayoutReport["totals"]> = {};

    for (const [width, viewport] of [[390, VIEWPORTS.mobile], [1280, VIEWPORTS.desktop], [1920, WIDE]] as const) {
        await page.setViewport(viewport);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

        assert.ok(report !== undefined, `${name} ${width}: a layout report`);
        totals[width] = report.totals;

        if (SHOTS !== undefined) {
            mkdirSync(SHOTS, { recursive: true });
            writeFileSync(join(SHOTS, `${name}-${width}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
            writeFileSync(join(SHOTS, `${name}-${width}.layout.txt`), `${describeLayout(report)}\nTOTALS ${JSON.stringify(report.totals)}\nISSUES ${JSON.stringify(report.issues)}\n`);
        }
    }

    await page.setViewport(VIEWPORTS.mobile);

    return totals;
}

test("a changed host key on the row: the old key and the new, Replace key keeps it connected, and the row and a session's dock clear at once", { skip }, async () => {
    const { id: onMachine } = await app.commands.createSession(owner(app), { cwd: `machine:${machineId}:${remoteHome}` });

    await changeHostKey();
    // The session on the machine, in another tab: its dock says the machine does not answer.
    await dock.setViewport(VIEWPORTS.mobile);
    await dock.navigate(`${base}/s/${onMachine}`);
    await until(async () => (await text(dock, "[data-part=machine-bar]")).includes("does not answer"), "the dock's error", 30_000);
    assert.match(await text(dock, "[data-part=machine-bar]"), /host key of 127\.0\.0\.1 changed/);

    await openMachines();
    await until(async () => (await text(sheet, ".machine .machine-problem")) !== "", "the row's health", 30_000);
    const before = await checked("rekey-row");

    console.log(`layout totals, row with a changed key: ${JSON.stringify(before)}`);
    const row = await text(sheet, ".machine");

    assert.match(row, /Host key changed/);
    assert.match(row, /Its host key changed since you accepted it\./);
    await press("Check the new key");
    await until(async () => (await text(sheet, "[data-part=machine-replace-key]")) !== "", "the old key and the new");
    const compare = await text(sheet, "[data-part=machine-replace-key]");
    const old = app.machines.get(machineId).hostKey!;

    assert.ok(compare.includes(old), compare);
    assert.match(compare, /It presents now\s+SHA256:\S+ \(ED25519\)/);
    assert.ok(!compare.includes(`It presents now\n${old}`), "the new key is not the old one");
    assert.match(compare, /may be an attack/);
    console.log(`layout totals, the old key and the new: ${JSON.stringify(await checked("rekey-compare"))}`);

    await press("Replace key");
    await until(async () => app.machines.get(machineId).hostKey !== old, "the key replaced", 30_000);
    await until(async () => !(await text(sheet, ".machine")).includes("Host key changed") && (await text(sheet, ".machine")).includes("Answers now"), "the row clears", 30_000);
    assert.ok(app.machines.get(machineId).remote, "still connected: no Install and connect");
    assert.equal(await hasButton("Install and connect"), false);
    // The other tab's dock, without a reload or the tab hidden and shown.
    await until(async () => (await text(dock, "[data-part=machine-bar]")) === "", "the dock clears", 30_000);
    console.log(`layout totals, after: ${JSON.stringify(await checked("rekey-after"))}`);
});

test("Forget, Scan, Accept, Install and connect on the row: no error from before stays on it", { skip }, async () => {
    await changeHostKey();
    await openMachines();
    await until(async () => (await text(sheet, ".machine .machine-problem")) !== "", "the row's health", 30_000);
    await sheet.evaluate(`window.confirm = () => true; return "true";`);
    await press("Forget host key");
    await until(() => hasButton("Scan host key"), "Scan host key", 30_000);
    await press("Scan host key");
    await until(() => hasButton("Accept this key"), "Accept this key", 30_000);
    await press("Accept this key");
    await until(() => hasButton("Install and connect"), "Install and connect", 30_000);
    // Nothing to download: every tool unticked, once the list is there.
    await until(async () => inPage<boolean>(sheet, `return JSON.stringify(document.querySelectorAll(".machine .machine-tool input").length > 0)`), "the tools to tick", 30_000);
    await sheet.evaluate(`for (const box of document.querySelectorAll(".machine .machine-tool input")) if (box.checked) box.click(); return "true";`);
    await press("Install and connect");
    await until(() => app.machines.get(machineId).remote !== undefined, "connected", 60_000);
    await until(async () => /pi-env \d/.test(await text(sheet, ".machine")), "the row connected", 30_000);
    // It answers now: the row says so within a few seconds, not the error it showed before.
    await until(async () => (await text(sheet, ".machine")).includes("Answers now"), "the row checked again", 15_000).catch(() => undefined);
    const row = await text(sheet, ".machine");

    assert.doesNotMatch(row, /Can't connect|Host key changed/);
    assert.match(row, /Answers now/);
});

test("Pi's machine_rekey card: the old key and the new, the one Pi read; Replace key keeps the machine connected", { skip }, async () => {
    await changeHostKey();
    const old = app.machines.get(machineId).hostKey!;
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "replace the devbox key", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id).length > 0, "the card", 30_000);
    await dock.setViewport(VIEWPORTS.mobile);
    await dock.navigate(`${base}/s/${id}`);
    await until(async () => (await text(dock, ".machine-add-card")) !== "", "the card", 30_000);
    const card = await text(dock, ".machine-add-card");

    assert.match(card, /Replace tuanlh-devbox-01's host key\?/);
    assert.match(card, /moved from han-proxmox to tuan-pve/);
    assert.ok(card.includes(old), card);
    assert.ok(card.includes(`${readThere} (ED25519)`), card);
    assert.match(card, /the one Pi read on the machine itself/);
    assert.match(card, /may be an attack/);
    console.log(`layout totals, Pi's card: ${JSON.stringify(await checked("rekey-card", dock))}`);
    await dock.evaluate(`[...document.querySelectorAll(".machine-add-card .button.primary")].find((each) => each.innerText.trim() === "Replace key").click(); return "true";`);
    await until(() => app.machines.get(machineId).hostKey === `${readThere} (ED25519)`, "the key replaced", 30_000);
    assert.ok(app.machines.get(machineId).remote, "still connected");
});

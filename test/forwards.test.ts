// Ports of a machine opened here (PP-104): the forward reaches a dev server on the machine's ::1 too (localhost), keeps
// the host whatever pi-env's arguments hold, a missing ssh is an error and not a crash, and a forward that ends by itself
// is said to the owner, whose tabs get the list again. ssh is a stand-in on PATH that does what each test needs.
import { type App, cleanUp, fakeTab, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { forwardArguments } from "../src/server/forwards.ts";

let app: App;
let machineId: string;
const bin = join(root, "fake-ssh-bin");
const said = join(root, "fake-ssh-args.json");
const PATH = process.env.PATH;

// Listens on the -L port for `FAKE_SSH_UP` ms ("fail": not at all), then ends as ssh does when a connection drops.
const FAKE_SSH = `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(said)}, JSON.stringify(args));
const up = Number(process.env.FAKE_SSH_UP ?? "0");
if (up === 0) { process.stderr.write("ssh: connect to host box port 22: Connection refused\\n"); process.exit(255); }
const local = Number(args[args.indexOf("-L") + 1].split(":")[1]);
const server = createServer((socket) => socket.end()).listen(local, "127.0.0.1");
setTimeout(() => { server.close(); process.stderr.write("Connection to box closed by remote host.\\n"); process.exit(255); }, up);
`;

before(async () => {
    app = await openApp(scriptedModel());
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ssh"), FAKE_SSH);
    chmodSync(join(bin, "ssh"), 0o755);
    const key = await app.sshKeys.generate("ports");
    const machine = app.machines.add({ name: "box", address: "me@box", keyId: key.id });

    machineId = machine.id;
    Object.assign(app.machines.get(machineId), { hostKey: "SHA256:test (ED25519)", remote: { platform: "linux", arch: "x64", home: "/home/me" } });
});

after(async () => {
    process.env.PATH = PATH;
    await app.close();
    cleanUp();
});

test("the forward goes to localhost there (a dev server on ::1 too), and the host stays whatever pi-env adds (PP-105, PP-107)", () => {
    const withClear = forwardArguments(["-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", "--", "me@box"], 4100, 5173);

    assert.deepEqual(withClear, ["-o", "BatchMode=yes", "-N", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:4100:localhost:5173", "--", "me@box"]);

    // Without ClearAllForwardings, nothing else is taken out: `--` and the host stay.
    const without = forwardArguments(["-o", "BatchMode=yes", "--", "me@box"], 4100, 5173);

    assert.deepEqual(without.slice(-2), ["--", "me@box"]);
    assert.ok(without.includes("127.0.0.1:4100:localhost:5173"));
    assert.throws(() => forwardArguments(["me@box"], 1, 2), /no -- before the host/);
});

test("ssh that cannot start is a 502 with why, not a crash (PP-106)", async () => {
    process.env.PATH = join(root, "no-programs-here");

    try {
        await assert.rejects(app.forwards.open(machineId, 3000), { status: 502, message: /Could not open port 3000 of box: ssh could not start: spawn ssh ENOENT/ });
    } finally {
        process.env.PATH = PATH;
    }

    assert.deepEqual(app.forwards.list(), []);
});

test("a forward that ends by itself is said to the owner, and their tabs get the list again (PP-108)", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    process.env.PATH = `${bin}:${PATH}`;
    process.env.FAKE_SSH_UP = "1500";

    try {
        const forward = await app.forwards.open(machineId, 5173);
        const args = JSON.parse(readFileSync(said, "utf8")) as string[];

        assert.equal(args[args.indexOf("-L") + 1], `127.0.0.1:${forward.localPort}:localhost:5173`);
        assert.deepEqual(args.slice(args.indexOf("--")), ["--", "box"], "the host is there, after --");
        assert.deepEqual(
            (tab.last("forwards") as { forwards: { id: string }[] }).forwards.map((each) => each.id),
            [forward.id],
            "the opened port reached the tab",
        );

        for (let tries = 0; tries < 100 && app.forwards.list().length > 0; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.deepEqual(app.forwards.list(), []);
        assert.deepEqual(tab.last("forwards"), { forwards: [] });
        assert.match(String((tab.last("notice") as { message: string }).message), /^Port 5173 of box closed: Connection to box closed by remote host\.$/);

        // Refused at once: the same as before, with ssh's words.
        process.env.FAKE_SSH_UP = "0";
        await assert.rejects(app.forwards.open(machineId, 5174), { status: 502, message: /Connection refused/ });
    } finally {
        process.env.PATH = PATH;
        delete process.env.FAKE_SSH_UP;
        app.detach(tab.client);
    }
});

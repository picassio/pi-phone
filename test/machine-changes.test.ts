// A machine that changes drops its connection and environments at once (PP-87): an edited name, address or key, a
// removal, or a forgotten host key reach every session's next command, not only after a restart.
import { type App, cleanUp, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatPlace } from "../src/server/places.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

/** A machine as if "Install and connect" had run: environments are lazy, so none of this reaches for ssh. */
async function connectedMachine(name: string): Promise<{ id: string; cwd: string }> {
    const key = await app.sshKeys.generate(name);
    const machine = app.machines.add({ name, address: `me@${name}`, keyId: key.id });

    Object.assign(app.machines.get(machine.id), {
        hostKey: "SHA256:test (ED25519)",
        remote: { platform: "linux", arch: "x64", home: "/home/me" },
        connectedAt: Date.now(),
    });

    return { id: machine.id, cwd: formatPlace({ machineId: machine.id, path: "/home/me/work" }) };
}

test("an edited machine gets a new environment; a new address must be set up again; a removed one is gone", async () => {
    const { id, cwd } = await connectedMachine("box");
    const first = app.places.env(cwd);

    assert.equal(app.places.env(cwd), first, "kept while nothing changes");

    await app.machines.edit(id, { name: "box renamed" });
    const renamed = app.places.env(cwd);

    assert.notEqual(renamed, first, "a new environment after a change");

    await app.machines.edit(id, { address: "me@elsewhere" });
    assert.throws(() => app.places.env(cwd), { status: 409, message: /not set up/ });

    Object.assign(app.machines.get(id), { remote: { platform: "linux", arch: "x64", home: "/home/me" } });
    assert.notEqual(app.places.env(cwd), renamed, "the old address's environment is not used again");
    await app.machines.remove(id);
    assert.throws(() => app.places.env(cwd), { status: 404 });
});

test("a forgotten host key drops the connection too", async () => {
    const { id, cwd } = await connectedMachine("other");
    const first = app.places.env(cwd);

    await app.machines.forget(id);
    assert.throws(() => app.places.env(cwd), { status: 409, message: /not set up/ });
    Object.assign(app.machines.get(id), { remote: { platform: "linux", arch: "x64", home: "/home/me" } });
    assert.notEqual(app.places.env(cwd), first);
});

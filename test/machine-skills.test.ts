// pi-phone's own skills in sessions on a machine (PP-441): which are copied, the key, where they are listed there, and
// the copy itself (once, again for a new key, tried again after a failure). The machine is a folder here, its scripts
// run by sh with HOME set to it; remote-session.test.ts checks the same over a real machine connection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { DESIGN_MACHINE_SKILLS } from "../src/server/design-systems.ts";
import { MachineSkills, machineSkillsText, skillBundle, skillsThere } from "../src/server/machine-skills.ts";
import type { Machine } from "../src/server/machines.ts";
import type { Places } from "../src/server/places.ts";

const root = mkdtempSync(join(tmpdir(), "machine-skills-test-"));
const agentDir = join(root, "agent");

after(() => rmSync(root, { recursive: true, force: true }));

const skill = (folder: string, name: string, extra: Record<string, string> = {}) => {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(join(folder, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`);

    for (const [file, text] of Object.entries(extra)) {
        mkdirSync(join(folder, name, file, ".."), { recursive: true });
        writeFileSync(join(folder, name, file), text);
    }
};

test("the app's skills for a machine: html-plan and the others that work there; never getting-started, design-system, brand-extract or extension-builder", () => {
    const bundle = skillBundle(
        [join(APP_ROOT, "src", "skills"), join(APP_ROOT, "third_party", "effective-html", "skills"), ...DESIGN_MACHINE_SKILLS],
        agentDir,
    );
    const names = bundle.skills.map((each) => each.name);

    for (const name of ["ui-verify", "html", "html-plan", "design-artifact", "gsap-core", "business-motion-film", "unslop"]) {
        assert.ok(names.includes(name), `${name} goes to machines: ${names.join(", ")}`);
    }

    for (const name of ["getting-started", "design-system", "brand-extract", "extension-builder", "statechart", "officecli"]) {
        assert.ok(!names.includes(name), `${name} does not`);
    }

    assert.match(bundle.key, /^[0-9a-f]{16}$/);
    assert.equal(skillBundle([join(APP_ROOT, "src", "skills")], agentDir).skills.length, 1, "src/skills: ui-verify alone");
});

test("the key follows the skills' files; two skill folders of one name are refused", () => {
    const a = join(root, "keyed-a");
    const b = join(root, "keyed-b");

    skill(a, "one", { "references/notes.md": "first" });
    const first = skillBundle([a], agentDir);

    assert.equal(skillBundle([a], agentDir).key, first.key, "the same files, the same key");
    writeFileSync(join(a, "one", "references", "notes.md"), "second");
    assert.notEqual(skillBundle([a], agentDir).key, first.key, "a changed file, another key");
    skill(b, "two");
    // Another skill's folder named "one" (its name differs): both would land in the copy's one/.
    mkdirSync(join(b, "nested", "one"), { recursive: true });
    writeFileSync(join(b, "nested", "one", "SKILL.md"), "---\nname: other\ndescription: Another.\n---\n");
    assert.throws(() => skillBundle([a, join(b, "nested")], agentDir), /Two of the app's skills are in folders named one/);
});

test("listed at their place on the machine, with their own files beside them", () => {
    const folder = join(root, "listed");

    skill(folder, "plan", { "references/x.md": "x" });
    const bundle = skillBundle([folder], agentDir);
    const [there] = skillsThere(bundle, "/home/ann");

    assert.equal(there!.filePath, `/home/ann/.pi/mobile/skills/${bundle.key}/plan/SKILL.md`);
    assert.equal(there!.baseDir, `/home/ann/.pi/mobile/skills/${bundle.key}/plan`);
});

/** A machine that is a folder here: its commands run by sh with HOME set to it, its files written there. */
function fakeMachine(home: string, fail: { exec?: boolean } = {}) {
    const ran: string[] = [];
    const written: string[] = [];
    const env = {
        exec: async (command: string[] | string, options: { onOutput?: (text: string) => void }) => {
            const script = Array.isArray(command) ? command[2]! : command;

            ran.push(script);

            if (fail.exec === true) {
                return { ok: false, error: new Error("connection lost") };
            }

            const done = spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });

            options.onOutput?.(done.stdout + done.stderr);

            return { ok: true, value: { exitCode: done.status ?? 1 } };
        },
        createDir: async (path: string) => {
            mkdirSync(path, { recursive: true });

            return { ok: true, value: undefined };
        },
        writeFile: async (path: string, bytes: Buffer) => {
            written.push(path);
            writeFileSync(path, bytes);

            return { ok: true, value: undefined };
        },
    };
    const places = { env: () => env } as unknown as Places;
    const machine = { id: "m1", name: "box", remote: { home, platform: "linux", arch: "x64" } } as unknown as Machine & { remote: NonNullable<Machine["remote"]> };

    return { places, machine, ran, written };
}

test("copied once per machine and key: a new key copies again and removes copies unused for 30 days; a failed copy is tried again", async () => {
    const folder = join(root, "copied");
    const home = join(root, "home");

    skill(folder, "plan", { "scripts/run.sh": "echo run\n" });
    mkdirSync(home);
    const bundle = skillBundle([folder], agentDir);
    const { places, machine, written } = fakeMachine(home);
    const copies = new MachineSkills(places);
    const listed = await copies.place(machine, bundle);
    const there = join(home, ".pi", "mobile", "skills", bundle.key);

    assert.equal(listed[0]!.filePath, join(there, "plan", "SKILL.md"));
    assert.equal(readFileSync(listed[0]!.filePath, "utf8"), readFileSync(join(folder, "plan", "SKILL.md"), "utf8"), "read finds it there");
    assert.equal(readFileSync(join(there, "plan", "scripts", "run.sh"), "utf8"), "echo run\n", "and its scripts, for bash");
    assert.ok(existsSync(join(there, ".done")));
    assert.ok(!existsSync(join(home, ".pi", "mobile", "skills", `${bundle.key}.tar.gz`)), "the archive is removed");
    assert.equal(written.length, 1);

    // Again while the app runs: nothing is asked of the machine.
    await copies.place(machine, bundle);
    assert.equal(written.length, 1);

    // The app started again: the machine has it, so only its mark is touched.
    const old = new Date(Date.now() - 40 * 86_400_000);

    utimesSync(join(there, ".done"), old, old);
    const again = fakeMachine(home);

    await new MachineSkills(again.places).place(again.machine, bundle);
    assert.equal(again.written.length, 0, "nothing copied");
    assert.ok(statSync(join(there, ".done")).mtimeMs > old.getTime() + 86_400_000, "its mark is touched");

    // A new app version with changed skills: copied again; a copy unused for 40 days goes, the one in use stays.
    const stale = join(home, ".pi", "mobile", "skills", "0123456789abcdef");

    mkdirSync(stale);
    writeFileSync(join(stale, ".done"), "");
    utimesSync(join(stale, ".done"), old, old);
    writeFileSync(join(folder, "plan", "SKILL.md"), "---\nname: plan\ndescription: Changed.\n---\n");
    const changed = skillBundle([folder], agentDir);

    assert.notEqual(changed.key, bundle.key);
    await copies.place(machine, changed);
    assert.match(readFileSync(join(home, ".pi", "mobile", "skills", changed.key, "plan", "SKILL.md"), "utf8"), /Changed/);
    assert.ok(!existsSync(stale), "the unused copy is removed");
    assert.ok(existsSync(join(there, ".done")), "the copy used lately stays");

    // A failed copy throws with the machine's word, and the next request tries again.
    const broken = fakeMachine(join(root, "home-broken"), { exec: true });
    const failing = new MachineSkills(broken.places);

    await assert.rejects(failing.place(broken.machine, bundle), /box: connection lost/);
    await assert.rejects(failing.place(broken.machine, bundle), /box: connection lost/);
    assert.equal(broken.ran.length, 2, "tried again");
});

test("the skills section says when the app's skills could not be copied", () => {
    assert.equal(machineSkillsText("", undefined), undefined);
    assert.equal(machineSkillsText("<available_skills/>", undefined), "<available_skills/>");
    assert.match(machineSkillsText("", "box: connection lost")!, /^pi-phone's own skills \(html-plan, ui-verify and the rest\) are not on this machine: copying them failed \(box: connection lost\)/);
});

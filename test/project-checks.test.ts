// The team's checks on running task sessions (project-runs.ts `Team.check`): an end that went unheard (a restart, a lost
// event) is handled once the session has been idle a while; a run whose session is gone fails; a session working past
// LONG_RUN_MS is reported to the main session once a stretch.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { localBoards } from "../src/server/boards.ts";
import type { PocketHost } from "../src/server/host.ts";
import { LONG_RUN_MS, Team, UNHEARD_AFTER_MS } from "../src/server/project-runs.ts";
import { type Actor, type Person, Projects } from "../src/server/projects.ts";

const OWNER: Person = { id: "u-owner", name: "Owner", role: "owner" };
const as: Actor = { kind: "person", person: OWNER };

type State = { busy: boolean; busySince?: number; waiting: boolean; failed: boolean; endedAt?: number };

/** Just what `Team.check` uses of the host; what it reports and settles is kept to look at. */
function fakeHost(states: Map<number, State | undefined>) {
    const reports: { session: number; message: string; via: string }[] = [];
    const settled: { session: number; reason: string }[] = [];
    const host = {
        people: () => [OWNER],
        sessionState: (session: number) => states.get(session),
        lastAnswer: async () => "All set; the tests pass.",
        sessionTitle: (session: number) => `session ${session}`,
        sendToSession: async (request: { session: number; message: string; via: string }) => {
            reports.push({ session: request.session, message: request.message, via: request.via });
        },
        settleSession: async (session: number, reason: string) => {
            settled.push({ session, reason });
        },
        notice: () => {},
        text: { quoted: (text: string) => `“${text}”` },
    };

    return { host: host as unknown as PocketHost, reports, settled };
}

/** A project with main session 100 and a task whose run is running in `session`. */
function running(projects: Projects, key: string, session: number) {
    projects.create(as, { key, name: "checks", folder: "/tmp/repo" });
    projects.update(as, key, { mainSession: "100" });
    const task = projects.createTask(as, key, { title: "Do it" });
    const run = projects.queueRun(as, task.ref);

    projects.setRun(run.id, { state: "running", conversationId: String(session), place: "/tmp/repo", branch: `task/${task.ref}`, base: "main", startedAt: 1 });

    return { task, run };
}

after(() => cleanUp());

test("a task session that ended unheard is handled after it has been idle a while, once", async () => {
    const projects = new Projects(mkdtempSync(join(root, "checks-")), () => [OWNER]);
    const states = new Map<number, State | undefined>([[7, { busy: false, waiting: false, failed: false }]]);
    const { host, reports, settled } = fakeHost(states);
    const team = new Team(projects, localBoards(projects), host);
    const { run } = running(projects, "CK", 7);
    const now = 1_000_000;

    await team.check(now);
    assert.equal(reports.length, 0, "first seen idle: maybe its run is about to resume");
    await team.check(now + UNHEARD_AFTER_MS - 1);
    assert.equal(reports.length, 0);
    await team.check(now + UNHEARD_AFTER_MS);
    assert.equal(projects.runsIn(["stopped"])[0]?.id, run.id, "the task is still not in review: its run stopped");
    assert.match(reports[0]!.message, /^Stopped: CK-1 \(Do it\) .*All set; the tests pass\./);
    assert.equal(reports[0]!.via, "CK-1 · task session #7");
    assert.deepEqual(settled, [{ session: 7, reason: "it stopped" }]);
    await team.check(now + 2 * UNHEARD_AFTER_MS);
    assert.equal(reports.length, 1, "handled once");
    projects.close();
});

test("an end this process saw counts from when it ended; a failed one fails the run", async () => {
    const projects = new Projects(mkdtempSync(join(root, "checks-")), () => [OWNER]);
    const now = 5_000_000;
    const states = new Map<number, State | undefined>([[8, { busy: false, waiting: false, failed: true, endedAt: now - UNHEARD_AFTER_MS }]]);
    const { host, reports } = fakeHost(states);
    const team = new Team(projects, localBoards(projects), host);

    running(projects, "CF", 8);
    await team.check(now);
    assert.equal(projects.runsIn(["failed"]).length, 1);
    assert.match(reports[0]!.message, /^Failed: CF-1 /);
    projects.close();
});

test("a run whose session is gone fails, and a session waiting for an approval is left alone", async () => {
    const projects = new Projects(mkdtempSync(join(root, "checks-")), () => [OWNER]);
    const states = new Map<number, State | undefined>([[9, undefined], [10, { busy: false, waiting: true, failed: false }]]);
    const { host, reports } = fakeHost(states);
    const team = new Team(projects, localBoards(projects), host);

    running(projects, "CG", 9);
    running(projects, "CW", 10);
    await team.check(1_000);
    await team.check(1_000 + 10 * UNHEARD_AFTER_MS);
    assert.deepEqual(projects.runsIn(["failed"]).map((run) => run.conversationId), ["9"]);
    assert.equal(projects.runsIn(["running"])[0]?.conversationId, "10");
    assert.equal(reports.length, 1);
    assert.match(reports[0]!.message, /^Failed: CG-1 \(Do it\)\. Its session #9 is gone/);
    projects.close();
});

test("a session working past LONG_RUN_MS is reported once a stretch", async () => {
    const projects = new Projects(mkdtempSync(join(root, "checks-")), () => [OWNER]);
    const states = new Map<number, State | undefined>([[11, { busy: true, busySince: 0, waiting: false, failed: false }]]);
    const { host, reports } = fakeHost(states);
    const team = new Team(projects, localBoards(projects), host);

    running(projects, "CL", 11);
    await team.check(LONG_RUN_MS - 1);
    assert.equal(reports.length, 0);
    await team.check(LONG_RUN_MS);
    await team.check(LONG_RUN_MS + 60_000);
    assert.equal(reports.length, 1, "once for this stretch");
    assert.match(reports[0]!.message, /^Still working: CL-1 \(Do it\) has worked for 30 minutes in session #11/);
    states.set(11, { busy: true, busySince: LONG_RUN_MS + 120_000, waiting: false, failed: false });
    await team.check(2 * LONG_RUN_MS + 120_000);
    assert.equal(reports.length, 2, "a new stretch, reported again");
    projects.close();
});

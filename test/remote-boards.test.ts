// Two pi-phones on the team server's boards (PP-40): Anna's and Binh's, each with its own local store, talking to one
// gateway board service on its internal port. A board Anna makes keeps its folder in her pi-phone only; shared with
// Binh, it is mirrored into his after a sync, and changes reach the other's mirror when the gateway pushes; Pi's
// sessions come back as plain numbers to their own pi-phone and namespaced to others; "pi" means the asker's own Pi;
// places are each one's own; a run stays in its runner's pi-phone while the others see its steps and whose session it
// is (PP-41); the project wiki is shared by its members' Pis, viewers only reading it (PP-42); and unsharing takes the board out of Binh's pi-phone, stopping his run there.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { BoardService } from "../src/gateway/boards.ts";
import { DocService } from "../src/gateway/docs.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { type Actor, type Person, Projects, type Run, type Task } from "../src/server/projects.ts";
import { type RemoteBoards, remoteBoards } from "../src/server/remote-boards.ts";

after(() => cleanUp());

const controller: ControllerClient = { ensure: async () => ({ host: "127.0.0.1", port: 1 }), list: async () => [], stop: async () => undefined, remove: async () => undefined, export: async () => Promise.reject(new Error("no")) };
const ME: Person = { id: "local-owner", name: "Me", role: "owner" };
const as: Actor = { kind: "person", person: ME };
const piIn = (conversationId: string): Actor => ({ kind: "pi", person: ME, conversationId, closer: "person" });

let store: GatewayStore;
let service: BoardService;
let internal: Server;
const ids: Record<string, string> = {};
const pushes: string[] = [];
const toPi: Task[] = [];
const stopped: { runs: Run[]; board: string }[] = [];
let anna: { boards: RemoteBoards; projects: Projects };
let binh: { boards: RemoteBoards; projects: Projects };

before(async () => {
    const db = new DatabaseSync(":memory:");
    const origin = "https://team.example.test";

    store = new GatewayStore(db);

    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    for (const name of ["Anna", "Binh"]) {
        ids[name] = ((await auth.api.createUser({ body: { name, email: `${name.toLowerCase()}@example.test`, password: "a long enough password", role: "member" } })) as { user: { id: string } }).user.id;
    }

    const dir = mkdtempSync(join(root, "gw-boards-"));

    service = new BoardService(store, dir);
    service.onChange((projectId) => pushes.push(projectId));
    service.onAssignedToPi((task) => toPi.push(task));

    const gateway = new Gateway({ auth, store, controller, boards: service, docs: new DocService(store, service, dir), origin, log: () => undefined });

    internal = createServer((request, response) => void gateway.internal(request, response));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));

    const url = `http://127.0.0.1:${(internal.address() as { port: number }).port}`;
    const phone = (name: string) => {
        const projects = new Projects(mkdtempSync(join(root, `pi-phone-${name}-`)), () => [ME]);

        return { projects, boards: remoteBoards({ url, token: store.box(ids[name]!).token, projects, stopped: (runs, board) => stopped.push({ runs, board }) }) };
    };

    anna = phone("Anna");
    binh = phone("Binh");
});

after(() => {
    internal?.close();
    service?.close();
});

test("pi-phones share a board through the gateway, each with its own mirror, places and Pi", async () => {
    // Anna's board: its folder is hers, never the gateway's.
    const made = await anna.boards.create(as, { key: "web", name: "Website", folder: "/data/home/web" });

    assert.deepEqual([made.key, made.folder], ["WEB", "/data/home/web"]);
    assert.equal(service.membersOf(made.id).length, 1);
    assert.equal(anna.projects.personalOf(made.id)?.folder, "/data/home/web", "kept in her pi-phone");

    // Shared with Binh: his pi-phone mirrors it on sync, without her folder.
    await anna.boards.setMembers(as, "WEB", [ids.Binh!]);
    await binh.boards.sync();
    assert.deepEqual(binh.projects.allProjects().map((project) => [project.key, project.folder]), [["WEB", null]]);

    // Binh's Pi makes a task and takes it ("pi" is his own Pi), and comments from session 3.
    const task = await binh.boards.createTask(piIn("3"), "WEB", { title: "Header", assignee: "pi" });

    assert.equal(task.assignee, `pi:${ids.Binh}`);
    assert.deepEqual(toPi.map((each) => each.ref), ["WEB-1"], "the gateway hears it's for Binh's Pi");
    await binh.boards.comment(piIn("3"), task.ref, "On it.");
    assert.equal((await binh.boards.task(as, task.ref)).comments.at(-1)?.session, "3", "his own session, as a number");
    assert.equal((await anna.boards.task(as, task.ref)).comments.at(-1)?.session, `${store.box(ids.Binh!).key}:3`, "Binh's session, to Anna");

    // Anna's mirror follows when the gateway tells her pi-phone.
    assert.equal(anna.projects.tasks(as, "WEB").length, 0, "not yet");
    await anna.boards.received({ projectId: made.id });
    assert.deepEqual(anna.projects.tasks(as, "WEB").map((each) => each.title), ["Header"]);

    // Places are each one's own: Binh's clone, and Anna's folder untouched.
    const his = await binh.boards.update(as, "WEB", { places: [{ folder: "/data/home/binh-web", cap: 1 }] });

    assert.deepEqual(his.places, [{ folder: "/data/home/binh-web", cap: 1 }]);
    assert.equal((await anna.boards.project(as, "WEB")).folder, "/data/home/web");

    // The project wiki (PP-42): Anna writes, Binh's Pi finds it and edits it, as "Pi (Binh)"; a viewer only reads.
    const before = pushes.length;

    await anna.boards.wiki("wikiWrite", ["WEB", { title: "Deploy notes", body: "We deploy the site with docker compose." }], as);
    assert.ok(pushes.length > before, "a wiki change is pushed like a board change");
    assert.deepEqual(((await binh.boards.wiki("wikiSearch", ["WEB", "docker"], piIn("3"))) as { slug: string }[]).map((hit) => hit.slug), ["deploy-notes"]);
    await binh.boards.wiki("wikiEdit", ["WEB", "deploy-notes", [{ oldText: "docker compose", newText: "docker compose on the devbox" }]], piIn("3"));
    const notes = (await anna.boards.wiki("wikiRead", ["WEB", "deploy-notes"], as)) as { body: string; updatedByName: string };

    assert.deepEqual([notes.body, notes.updatedByName], ["We deploy the site with docker compose on the devbox.", "Pi (Binh)"]);
    await anna.boards.setMembers(as, "WEB", [ids.Binh!], { [ids.Binh!]: "viewer" });
    await assert.rejects(binh.boards.wiki("wikiWrite", ["WEB", { title: "Mine", body: "x" }], as), /viewer on WEB/);
    assert.equal(((await binh.boards.wiki("wikiList", ["WEB"], as)) as unknown[]).length, 1, "but reads it");
    await anna.boards.setMembers(as, "WEB", [ids.Binh!]);

    // Binh runs his task in his own pi-phone; then Anna unshares the board: his pi-phone lets it go, and his run stops.
    const run = binh.projects.queueRun(as, task.ref);

    assert.equal(run.state, "queued");
    // His run is his pi-phone's: laid over the shared task there; Anna sees what his pi-phone shares of it (PP-41).
    assert.equal((await binh.boards.task(as, task.ref)).task.run?.id, run.id);
    assert.equal((await anna.boards.task(as, task.ref)).task.run, null, "not in hers");
    await binh.boards.linkSession(as, task.ref, "5", "worker");
    await binh.boards.recordRun(as, task.ref, { state: "running", branch: "task/WEB-1", conversationId: "5" });
    const seen = await anna.boards.task(as, task.ref);
    const step = seen.activity.filter((event) => event.kind === "run").at(-1)!;

    assert.deepEqual([step.data.state, step.data.branch, step.data.session, step.data.by], ["running", "task/WEB-1", `${store.box(ids.Binh!).key}:5`, "Binh"]);
    assert.deepEqual(seen.sessions.map((session) => [session.role, (session as { by?: string }).by]), [["linked", "Binh"], ["worker", "Binh"]], "his sessions (his Pi touched it from 3, ran it in 5), named");
    assert.deepEqual((await binh.boards.task(as, task.ref)).sessions.map((session) => session.conversationId), ["3", "5"], "his own, as numbers");
    // A run that ends before its session starts is still his, to Anna.
    await binh.boards.recordRun(as, task.ref, { state: "failed", branch: "task/WEB-1", conversationId: null });
    assert.equal((await anna.boards.task(as, task.ref)).activity.filter((event) => event.kind === "run").at(-1)?.data.by, "Binh");
    await anna.boards.setMembers(as, "WEB", []);
    await binh.boards.received({ projectId: made.id });
    assert.deepEqual(binh.projects.allProjects(), [], "gone from his pi-phone");
    assert.deepEqual(stopped.map((each) => [each.board, each.runs.map((one) => one.id)]), [["WEB", [run.id]]]);
    assert.equal(binh.projects.runsOf(made.id)[0]?.state, "stopped");
    await assert.rejects(binh.boards.board(as, "WEB"), /no project WEB/);
    assert.ok(pushes.length > 0, "the gateway hears every change, to tell running pi-phones");
});

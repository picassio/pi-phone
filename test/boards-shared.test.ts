// Shared boards' rules in the store (PP-39), as the team server's people have them: everyone a guest of the board
// service, with two of their role's permissions (seesAll for projects.view_all, managesTeam for projects.team). A
// board's leads, members and viewers; team boards that belong to nobody in particular, open to everyone or not;
// unsharing someone gives their tasks (and their Pi's) back to nobody with a comment; members leave, makers can't; an
// account that is gone leaves every board and its boards become the team's; and a person's own Pi as an assignee.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Actor, type Person, Projects, TEAM } from "../src/server/projects.ts";

after(() => cleanUp());

const ANNA: Person = { id: "anna", name: "Anna", role: "guest", managesTeam: true };
const BINH: Person = { id: "binh", name: "Binh", role: "guest" };
const CHI: Person = { id: "chi", name: "Chi", role: "guest" };
const AUDIT: Person = { id: "audit", name: "Auditor", role: "guest", seesAll: true };
const VIEWER: Person = { id: "vee", name: "Vee", role: "viewer" };
let everyone = [ANNA, BINH, CHI, AUDIT, VIEWER];
const as = (person: Person): Actor => ({ kind: "person", person });
const piOf = (person: Person, conversationId = "k:1"): Actor => ({ kind: "pi", person, conversationId, closer: "person" });

function store(): Projects {
    return new Projects(mkdtempSync(join(root, "boards-")), () => everyone);
}

test("a board's leads, members and viewers; seeing everything is not changing anything", () => {
    const boards = store();

    boards.create(as(BINH), { key: "WEB", name: "Website" });
    assert.deepEqual(boards.list(as(CHI)), [], "personal: only its maker");
    boards.setMembers(as(BINH), "WEB", ["chi", "anna"], { chi: "viewer", anna: "lead" });

    const board = boards.project(as(BINH), "WEB");

    assert.deepEqual(board.memberRoles, { anna: "lead", chi: "viewer" });
    assert.equal(boards.roleOn(BINH, board), "lead", "its maker leads it");

    // A viewer reads, never changes.
    assert.equal(boards.list(as(CHI)).length, 1);
    assert.throws(() => boards.createTask(as(CHI), "WEB", { title: "x" }), /viewer on WEB/);
    // A lead manages members; a member changes tasks but not members.
    boards.setMembers(as(ANNA), "WEB", ["chi", "anna"], { chi: "member", anna: "lead" });
    const task = boards.createTask(as(CHI), "WEB", { title: "Header" });

    assert.throws(() => boards.setMembers(as(CHI), "WEB", ["chi"]), /owner or its leads/);
    // Seeing every board (projects.view_all) is only seeing.
    assert.equal(boards.board(as(AUDIT), "WEB").tasks.length, 1);
    assert.throws(() => boards.updateTask(as(AUDIT), task.ref, { title: "y" }), /viewer on WEB/);
    // An app viewer (no pi-phone of their own) never changes a board.
    assert.throws(() => boards.create(as(VIEWER), { key: "NO", name: "x" }), /view projects but not change/);
});

test("team boards: the team's, managed by whoever manages team boards, open to everyone or not; a board moved to the team", () => {
    const boards = store();

    assert.throws(() => boards.create(as(BINH), { key: "OPS", name: "Ops", team: true }), /not part of your role/);
    const ops = boards.create(as(ANNA), { key: "OPS", name: "Ops", team: true });

    assert.equal(ops.owner, TEAM);
    assert.deepEqual([ops.team, ops.memberRoles], [true, { anna: "lead" }]);
    assert.deepEqual(boards.list(as(BINH)), [], "closed: only its members");
    boards.setOpen(as(ANNA), "OPS", true);
    assert.equal(boards.list(as(BINH)).length, 1, "open: everyone on the team sees it");
    assert.equal(boards.roleOn(BINH, boards.project(as(BINH), "OPS")), "viewer", "as a viewer");
    assert.equal(boards.list(as(VIEWER)).length, 0, "but not app viewers, who have no pi-phone of their own");

    // No last-lead rule: whoever manages team boards manages it even when its leads are gone.
    boards.setMembers(as(ANNA), "OPS", ["binh"], { binh: "member" });
    assert.equal(boards.roleOn(ANNA, boards.project(as(ANNA), "OPS")), "lead", "Anna manages team boards");

    // A personal board moved to the team: its maker stays, as a lead; tasks stay.
    boards.create(as(ANNA), { key: "DOC", name: "Docs" });
    boards.createTask(as(ANNA), "DOC", { title: "Kept" });
    const moved = boards.moveToTeam(as(ANNA), "DOC");

    assert.deepEqual([moved.team, moved.memberRoles.anna, boards.board(as(ANNA), "DOC").tasks.length], [true, "lead", 1]);
    boards.create(as(BINH), { key: "MINE", name: "Mine" });
    assert.throws(() => boards.moveToTeam(as(BINH), "MINE"), /not part of your role/);
});

test("unsharing gives someone's tasks, and their Pi's, back to nobody with a comment; members leave, makers don't", () => {
    const boards = store();

    boards.create(as(ANNA), { key: "APP", name: "App" });
    boards.setMembers(as(ANNA), "APP", ["binh", "chi"]);
    const theirs = boards.createTask(as(ANNA), "APP", { title: "Binh's", assignee: "Binh" });
    const piTask = boards.createTask(as(ANNA), "APP", { title: "Binh's Pi", assignee: "pi:Binh" });
    const chis = boards.createTask(as(ANNA), "APP", { title: "Chi's", assignee: "chi" });

    assert.equal(piTask.assignee, "pi:binh", "a person's own Pi");
    assert.throws(() => boards.createTask(as(ANNA), "APP", { title: "x", assignee: "pi:Vee" }), /Vee's Pi cannot work on APP/);
    boards.comment(piOf(BINH), theirs.ref, "Started on it.");

    // Binh taken off: his task and his Pi's go back to nobody, with a comment; his history stays.
    boards.setMembers(as(ANNA), "APP", ["chi"]);
    const after = boards.task(as(ANNA), theirs.ref);

    assert.equal(after.task.assignee, null);
    assert.equal(boards.task(as(ANNA), piTask.ref).task.assignee, null);
    assert.match(after.comments.map((comment) => comment.text).join("\n"), /Started on it\.[\s\S]*Unassigned: Binh is no longer on APP\./);
    assert.throws(() => boards.board(as(BINH), "APP"), /no project APP/, "he no longer sees it");
    assert.throws(() => boards.comment(piOf(BINH), theirs.ref, "more"), /no project APP shared with the person you work for/, "nor does his Pi");

    // Chi leaves; Anna, its maker, can't.
    boards.leave(as(CHI), "APP");
    assert.equal(boards.task(as(ANNA), chis.ref).task.assignee, null);
    assert.throws(() => boards.leave(as(ANNA), "APP"), /You made APP/);
});

test("an account that is gone leaves every board, and the boards it made become the team's", () => {
    const boards = store();

    boards.create(as(BINH), { key: "OLD", name: "Binh's" });
    boards.setMembers(as(BINH), "OLD", ["chi"]);
    boards.create(as(ANNA), { key: "NEW", name: "Anna's" });
    boards.setMembers(as(ANNA), "NEW", ["binh"]);
    const task = boards.createTask(as(ANNA), "NEW", { title: "x", assignee: "binh" });

    everyone = everyone.filter((person) => person.id !== "binh");
    boards.forgetPerson("binh");

    const old = boards.project(as(CHI), "OLD");

    assert.deepEqual([old.team, old.members], [true, ["chi"]], "Chi keeps working on it; it's the team's now");
    assert.equal(boards.roleOn(ANNA, old), "lead", "whoever manages team boards manages it");
    assert.deepEqual(boards.project(as(ANNA), "NEW").members, []);
    assert.equal(boards.task(as(ANNA), task.ref).task.assignee, null);
    everyone = [ANNA, BINH, CHI, AUDIT, VIEWER];
});

// Ask before paying, sending, booking or deleting (PP-455, src/server/risky.ts): which controls count, in English,
// Vietnamese and Chinese, as whole words; what a form's address adds; and the owner's card: Approve once, Deny, nobody
// answering in time, and a session that is not the owner's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Approvals } from "../src/server/host.ts";
import { type Approve, approveFor, riskOf, riskWords, riskyAddress, riskyWord, type RiskyStep } from "../src/server/risky.ts";
import createBrowser from "../src/server/extensions/browser.ts";
import createComputer from "../src/server/extensions/computer.ts";
import { cleanUp, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

test("a control that pays, sends, books or deletes, by its name: whole words, any case, in en, vi and zh", () => {
    const asks: [string, string][] = [
        ["Pay 49.00 EUR now", "pay"],
        ["PAY", "pay"],
        ["Buy now", "buy"],
        ["Place order", "place order"],
        ["Proceed to checkout", "checkout"],
        ["Check out", "check out"],
        ["Confirm payment", "confirm payment"],
        ["Subscribe", "subscribe"],
        ["Send", "send"],
        ["push button Send", "send"],
        ["Book a table", "book"],
        ["Reserve", "reserve"],
        ["Delete", "delete"],
        ["Remove account", "remove account"],
        ["Transfer 200 EUR", "transfer"],
        // Safe ones that ask too: a tap for the owner, never a payment without one.
        ["Send feedback", "send"],
        ["Delete filter", "delete"],
        ["Thanh toán", "thanh toán"],
        ["THANH TOÁN NGAY", "thanh toán"],
        ["Đặt hàng", "đặt hàng"],
        ["Mua ngay", "mua"],
        ["Gửi", "gửi"],
        ["Xóa tài khoản", "xóa"],
        ["Xoá", "xoá"],
        ["Chuyển khoản", "chuyển khoản"],
        ["立即购买", "购买"],
        ["确认支付", "支付"],
        ["删除筛选", "删除"],
        ["提交订单", "提交订单"],
        // "Mua" is buy: a shopping tab ("Mua sắm") asks too.
        ["Mua sắm", "mua"],
    ];

    for (const [name, word] of asks) {
        assert.equal(riskyWord(name), word, name);
    }

    // Words that only look alike: no card.
    for (const name of ["Payment history", "Payments", "Booking.com", "Facebook", "Notebook", "Sender: Ada", "Deleted items", "Buyer's guide", "Checkouts", "Go", "Search", "Apply coupon", "Save draft", "Đặt lại mật khẩu"]) {
        assert.equal(riskyWord(name), undefined, name);
    }
});

test("a form's address and its submit button make a submit risky; a plain one does not", () => {
    assert.equal(riskyAddress("https://shop.test/checkout/confirm"), "checkout");
    assert.equal(riskyAddress("https://bank.test/transfer?to=1"), "transfer");
    assert.equal(riskyAddress("https://shop.test/api/orders"), "orders");
    assert.equal(riskyAddress("https://shop.test/search?q=lamp"), undefined);
    assert.equal(riskyAddress("https://shop.test/payments-history"), "payments");
    assert.deepEqual(riskOf("Continue", { action: "https://shop.test/checkout/confirm", button: "Continue" }), { word: "checkout", found: "address" });
    assert.deepEqual(riskOf("Coupon", { action: "https://shop.test/cart", button: "Place order" }), { word: "place order", found: "button" });
    assert.equal(riskOf("Search", { action: "https://shop.test/search", button: "Search" }), undefined);
    assert.deepEqual(riskOf("Pay 49.00 EUR now"), { word: "pay", found: "name" });
    assert.equal(riskWords({ word: "checkout", found: "address" }), "checkout, in the address its form goes to");
    assert.equal(riskWords({ word: "place order", found: "button" }), "place order, its form's button");
});

/** The owner's card through the real `Approvals`: who Pi works for is `role`. */
function cards(role: "owner" | "member", wait?: number) {
    const approvals = new Approvals(() => "u1");
    const host = { approvals, requesterOf: () => "u1", people: () => [{ id: "u1", name: "Tuan", role }] };
    const approve = approveFor(host as never, { conversationId: 7, taskId: "t1", callId: "c1" }, BACKGROUND_CONTEXT, wait);

    return { approvals, approve };
}

const STEP: RiskyStep = { tool: "browser_click", control: "Pay 49.00 EUR now", risk: { word: "pay", found: "name" }, where: "Your cart \u2014 https://shop.test/cart", place: "browser" };

test("the card: what, why and where; Approve once goes ahead, Deny does not, and each action has a card of its own", async () => {
    const { approvals, approve } = cards("owner");
    const first = approve(STEP);
    const card = approvals.all()[0]!;

    assert.equal(card.id, "risky-t1-c1-1");
    assert.equal(card.tool, "browser_click");
    assert.equal(card.subject, "Pay 49.00 EUR now");
    assert.deepEqual(card.form, { type: "risky", control: "Pay 49.00 EUR now", word: "pay", found: "name", where: "Your cart \u2014 https://shop.test/cart", place: "browser" });
    assert.equal(card.reason, "It may pay, send, book or delete (pay). Approve once lets this one action go ahead; Deny stops it.");
    approvals.answer(card.id, { allow: true, by: "Tuan" });
    assert.equal(await first, true);

    const second = approve(STEP);

    assert.equal(approvals.all()[0]!.id, "risky-t1-c1-2", "the next asks again");
    approvals.answer("risky-t1-c1-2", { allow: false, by: "Tuan" });
    assert.equal(await second, "Tuan denied it on the card:");
    assert.equal(approvals.all().length, 0);
});

test("nobody answering in time is a Deny, and the card goes; a session that is not the owner's is denied without a card", async () => {
    const late = cards("owner", 50);

    assert.equal(await late.approve(STEP), "Nobody answered the owner's card within 0.05 seconds, so it was denied:");
    assert.equal(late.approvals.all().length, 0);

    const member = cards("member");

    assert.match(String(await member.approve(STEP)), /^Only the owner approves a step that may pay, send, book or delete/);
    assert.equal(member.approvals.all().length, 0);
});

test("in the app, Approve once on the card is the owner's alone; anyone else can only deny", async () => {
    const app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));

    try {
        const id = await newSession(app);
        const guest = app.config.addUser("Lan", "guest").user;
        const me = owner(app);
        const host = { approvals: app.approvals, requesterOf: () => me.id, people: () => [{ id: me.id, name: me.name, role: "owner" }] };
        const approve = approveFor(host as never, { conversationId: id, taskId: "t1", callId: "c1" }, BACKGROUND_CONTEXT);
        const answered = approve(STEP);
        const card = app.approvals.forConversation(id)[0]!;

        assert.equal(card.form?.type, "risky");
        await assert.rejects(app.answerApproval(card.id, true, guest), /Approving a step that may pay, send, book or delete is the owner's/);
        assert.equal(app.approvals.forConversation(id).length, 1, "still waiting");
        await app.answerApproval(card.id, true, owner(app));
        assert.equal(await answered, true);
    } finally {
        await app.close();
        cleanUp();
    }
});

type Tool = { name: string; execute(args: unknown, api: unknown, context: unknown): Promise<{ output: { text: string }[]; isError?: boolean }> };

test("every tool that clicks or presses gives Pi's browser and computer control the owner's card: browser_click, browser_press, browser_type, browser_run, computer_act, computer_run", async () => {
    const approvals = new Approvals(() => "u1");
    // A stand-in browser and computer: each action asks about Pay at once, and says what the answer was.
    const ask = async (approve: Approve) => `answer: ${String(await approve(STEP))}`;
    const browser = {
        click: (_session: number, _index: number, approve: Approve) => ask(approve),
        press: (_session: number, _key: string, approve: Approve) => ask(approve),
        type: (_session: number, _index: number, _text: string, _options: unknown, approve: Approve) => ask(approve),
        run: async (_session: number, options: { approve: Approve }) => ({
            result: { status: "stopped", reason: "blocked", detail: await ask(options.approve), steps: [], decisions: 0, cost: 0, tokens: { input: 0, output: 0 }, ms: 0 },
            page: "the page",
        }),
        windowAsks: () => [],
        permissionAsks: () => [],
    };
    const session = { machine: "m1", machineName: "box", conversationId: 7, session: 7, approvedBy: "Tuan", apps: [], reason: "test", startedAt: 0, until: Date.now() + 600_000 };
    const host = {
        approvals,
        requesterOf: () => "u1",
        people: () => [{ id: "u1", name: "Tuan", role: "owner" }],
        person: () => ({ id: "u1", name: "Tuan", role: "owner" }),
        browserFor: () => browser,
        browserRunModel: () => "session",
        // computer_run's model clicks Send.
        askSessionModel: async () => '{"operation": {"choice": "CLICK"}, "click_target": {"choice": "1"}}',
        apiKey: async () => undefined,
        chargeSession: async () => {},
        secrets: { value: () => undefined, used: () => {} },
        computer: {
            unavailable: () => undefined,
            sessionOfConversation: () => session,
            screen: async () => ({
                text: [
                    "App=mail (pid 1)",
                    'Window: "Mail", App: mail.',
                    "\t0 frame Mail Frame: {x: 0, y: 0, width: 420, height: 220}",
                    "\t\t1 push button Send Secondary Actions: click Frame: {x: 10, y: 10, width: 100, height: 30}",
                ].join("\n"),
            }),
            act: async (_session: unknown, _app: unknown, _action: unknown, guard: { tool: string; approve: Approve }) => {
                throw new Error(`${guard.tool} ${await ask(guard.approve)}`);
            },
        },
    };
    const tools = [...(createBrowser(host as never) as unknown as { tools: Tool[] }).tools, ...(createComputer(host as never) as unknown as { tools: Tool[] }).tools];
    const call = async (name: string, args: unknown) => {
        const tool = tools.find((each) => each.name === name)!;
        const done = tool.execute(args, { conversationId: 7, taskId: "t1", callId: name, agent: async () => ({ cwd: "/work" }) }, BACKGROUND_CONTEXT);

        for (let tries = 0; approvals.all().length === 0 && tries < 100; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const card = approvals.all()[0];

        assert.ok(card !== undefined, `${name} asked the owner`);
        assert.equal(card.form?.type, "risky", name);
        approvals.answer(card.id, { allow: false, by: "Tuan" });

        return (await done).output[0]!.text;
    };

    for (const [name, args] of [
        ["browser_click", { index: 3 }],
        ["browser_press", { key: "Enter" }],
        ["browser_type", { index: 3, text: "SAVE10", submit: true }],
        ["browser_run", { goal: "Pay for the cart" }],
        ["computer_act", { action: "click", index: 1 }],
        ["computer_run", { goal: "Send the mail" }],
    ] as const) {
        assert.match(await call(name, args), /answer: Tuan denied it on the card:/, name);
    }
});

// Ask before paying, sending, booking or deleting in Pi's browser (PP-455), with a Chrome on the machine (CI): a click
// on Pay, Enter in a form that goes to checkout, and a browser_run step on Pay each wait for the owner's card; a Deny
// clicks nothing (the run stops, blocked); an approval covers one click, and the next asks again; a plain link and a
// search form do not ask.
import { cleanUp, cleanUpAll } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { type Decider, type Question, readAnswers } from "../src/server/browser/run.ts";
import { answering, NO_CARD } from "./no-card.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/** A cart: Pay, a link that only looks alike, a form that goes to checkout behind a plain "Continue", a search form. */
const CART = `<!doctype html><title>Your cart</title><meta name="viewport" content="width=device-width">
    <style>body{font:16px sans-serif} button,input{display:block;margin:8px 0;height:40px}</style>
    <a href="#history" onclick="out.textContent='Opened payment history'">Payment history</a>
    <button onclick="paid++; out.textContent='Paid ' + paid">Pay 49.00 EUR now</button>
    <form action="/checkout/confirm" onsubmit="event.preventDefault(); out.textContent='Order placed'"><input aria-label="Coupon"><button>Continue</button></form>
    <form onsubmit="event.preventDefault(); out.textContent='Searched ' + q.value"><input id="q" aria-label="Search the shop"><button>Search</button></form>
    <p id="out">Nothing yet</p>
    <script>let paid = 0;</script>`;

let server: Server;
let port = 0;

before(async () => {
    server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(CART);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close(), () => cleanUp()));

function browserHere(): PiBrowser {
    return new PiBrowser({
        engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]),
        changed: () => {},
        frame: () => {},
        log: () => {},
    });
}

const number = (page: string, pattern: RegExp) => Number(pattern.exec(page)?.[1] ?? assert.fail(`${pattern} not in:\n${page}`));

test("with Chrome: browser_click on Pay asks; Deny clicks nothing; Approve clicks once and the next asks again; a plain link does not ask", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/cart");
        const pay = number(page, /\[(\d+)\] button "Pay 49\.00 EUR now"/);
        const denied = answering("Tuan denied it on the card:");

        await assert.rejects(browser.click(1, pay, denied), /^Error: Tuan denied it on the card: \[\d+\] Pay 49\.00 EUR now was not clicked \(it may pay, send, book or delete: pay\)\.$/);
        assert.deepEqual(denied.asked, [{ tool: "browser_click", control: "Pay 49.00 EUR now", risk: { word: "pay", found: "name" }, where: "Your cart \u2014 http://pi.test/cart", place: "browser" }]);
        assert.match(await browser.snapshot(1), /Nothing yet/, "nothing was clicked");

        const approve = answering();

        assert.match(await browser.click(1, pay, approve), /Paid 1/);
        assert.match(await browser.click(1, pay, approve), /Paid 2/);
        assert.equal(approve.asked.length, 2, "each click asks again");

        assert.match(await browser.click(1, number(page, /\[(\d+)\] link "Payment history"/), NO_CARD), /Opened payment history/);
    } finally {
        await browser.close();
    }
});

test("with Chrome: a form that goes to checkout asks, by its address, for a click and for Enter; a search form does not", { skip }, async () => {
    const browser = browserHere();

    try {
        const page = await browser.open(1, "http://pi.test/cart");
        const denied = answering("Tuan denied it on the card:");

        await assert.rejects(browser.click(1, number(page, /\[(\d+)\] button "Continue"/), denied), /was not clicked \(it may pay, send, book or delete: checkout, in the address its form goes to\)/);
        await assert.rejects(browser.type(1, number(page, /\[(\d+)\] textbox "Coupon"/), "SAVE10", { submit: true }, denied), /nothing was typed into \[\d+\] Coupon, nor Enter pressed/);
        await browser.type(1, number(page, /\[(\d+)\] textbox "Coupon"/), "SAVE10", {}, NO_CARD);
        await assert.rejects(browser.press(1, "Enter", denied), /Enter was not pressed on Coupon \(it may pay, send, book or delete: checkout/);
        assert.equal(denied.asked.length, 3);
        assert.match(await browser.snapshot(1), /Nothing yet/);

        assert.match(await browser.type(1, number(page, /\[(\d+)\] textbox "Search the shop"/), "lamp", { submit: true }, NO_CARD), /Searched lamp/);
    } finally {
        await browser.close();
    }
});

/** A run model that clicks the control whose words hold `label`, then says done. */
function clicking(label: string): Decider {
    let step = 0;

    return {
        label: "a script",
        async decide(_state, questions: Record<string, Question>) {
            step += 1;
            const criteria = (questions.click_target as { criteria: Record<string, string> } | undefined)?.criteria ?? {};
            const target = Object.keys(criteria).find((key) => criteria[key]!.includes(label));
            const answers: Record<string, unknown> = { operation: { choice: step === 1 ? "CLICK" : "DONE" }, goal_achieved: { noul: 0.9 } };

            for (const name of Object.keys(questions)) {
                if (name.endsWith("_target")) {
                    answers[name] = { choice: name === "click_target" && target !== undefined ? target : Object.keys((questions[name] as { criteria: object }).criteria)[0] };
                }
            }

            if (questions.value_for_field) {
                answers.value_for_field = { choice: "none" };
            }

            if (questions.prev_ok) {
                answers.prev_ok = { noul: 0.9 };
            }

            return { answers: readAnswers(questions, answers), cost: 0, tokens: { input: 0, output: 0 } };
        },
    };
}

test("with Chrome: a browser_run step on Pay asks; Deny stops the run, blocked, with nothing paid; Approve lets that click go", { skip }, async () => {
    const browser = browserHere();

    try {
        await browser.open(1, "http://pi.test/cart");
        const denied = answering("Tuan denied it on the card:");
        const stopped = await browser.run(1, { goal: "Pay for the cart", values: {}, maxSteps: 5, decider: clicking("Pay 49.00"), approve: denied });

        assert.equal(stopped.result.status, "stopped");
        assert.equal(stopped.result.reason, "blocked");
        assert.match(stopped.result.detail ?? "", /^Tuan denied it on the card: \[\d+\] Pay 49\.00 EUR now was not clicked \(it may pay, send, book or delete: pay\)\.$/);
        assert.deepEqual(denied.asked.map((step) => [step.tool, step.control]), [["browser_run", "Pay 49.00 EUR now"]]);
        assert.match(stopped.page, /Nothing yet/);

        const approve = answering();
        const paid = await browser.run(1, { goal: "Pay for the cart", values: {}, maxSteps: 5, decider: clicking("Pay 49.00"), approve });

        assert.equal(paid.result.status, "done", paid.result.detail ?? "");
        assert.match(paid.page, /Paid 1/);
        assert.equal(approve.asked.length, 1);
    } finally {
        await browser.close();
    }
});

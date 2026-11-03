// A reply to a selected passage (web/quote-text.js, PP-345 from pi-pocket): the passage goes out as a Markdown quote and
// shows as one.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: plain JS, no types.
import { QUOTE_MAX, splitQuote, withQuote } from "../web/quote-text.js";

test("a quoted passage goes out first, and reads back as it was", () => {
    const sent = withQuote("first line\n\nthird line", "why?");

    assert.equal(sent, "> first line\n>\n> third line\n\nwhy?");
    assert.deepEqual(splitQuote(sent), { passage: "first line\n\nthird line", rest: "why?" });
});

test("with no passage the reply goes out as it is, and a plain message shows no quote", () => {
    assert.equal(withQuote(null, "hello"), "hello");
    assert.equal(splitQuote("hello > not a quote"), null);
});

test("a long passage is cut", () => {
    const sent = withQuote("x".repeat(QUOTE_MAX + 500), "ok");

    assert.ok(sent.length < QUOTE_MAX + 20);
    assert.ok(sent.includes("…"));
});

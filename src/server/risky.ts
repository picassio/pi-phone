/**
 * Ask before paying, sending, booking or deleting (PP-455, the owner's decision of 2026-11-08). Before the one click or
 * key of Pi's that would do one of those, in Pi's browser (browser_click, browser_press and browser_type's Enter,
 * browser_run's steps) and in computer control (computer_act, computer_run's steps), the owner answers a card:
 * Approve once or Deny. An approval covers that one action only; the next asks again.
 *
 * Which control is risky: its name (or, for a form's submit, its submit button's name) holds one of `RISKY_WORDS`, a
 * whole word or phrase, case-insensitive; or the form it submits goes to an address with one of `RISKY_ADDRESS_WORDS`.
 * Words that only look alike stay out ("Payment history", "Booking.com", "Facebook"); some safe ones ask too ("Send
 * feedback", "Delete filter"), which costs a tap and is the safe side.
 *
 * Nobody to ask, or nobody answering within `RISKY_WAIT_MS`, is a Deny; so is a session that works for someone other
 * than the owner. Nothing here clicks: a Deny, a timeout, or an error stops the action before it happens.
 */
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { ApprovalRequest, PocketHost } from "./host.ts";

/** Words of a control that pays, sends, books or deletes, in pi-phone's languages. Latin and Vietnamese ones match as whole words; Chinese ones anywhere in the name. */
export const RISKY_WORDS = {
    en: [
        "pay",
        "make payment",
        "submit payment",
        "confirm payment",
        "buy",
        "purchase",
        "checkout",
        "check out",
        "place order",
        "place your order",
        "order now",
        "complete order",
        "confirm order",
        "subscribe",
        "send",
        "book",
        "reserve",
        "delete",
        "remove account",
        "close account",
        "transfer",
        "donate",
    ],
    vi: ["thanh toán", "đặt hàng", "đặt mua", "mua", "gửi", "xóa", "xoá", "chuyển khoản", "chuyển tiền", "đặt chỗ", "đặt phòng", "đặt vé"],
    zh: ["支付", "付款", "下单", "购买", "结账", "发送", "删除", "预订", "预定", "转账", "提交订单", "订阅"],
} as const;

/** Words of a form's address (its path and query, split at anything but letters and digits) that make submitting it risky. */
export const RISKY_ADDRESS_WORDS = ["pay", "payment", "payments", "checkout", "order", "orders", "purchase", "transfer"] as const;

/** What the run model is told (browser_run's and computer_run's CLICK): such a step goes to the owner first. */
export const RISKY_RUN_NOTE = "One that may pay, send, book or delete goes to the owner for approval first.";

/** How long a card waits for the owner before it counts as Deny. */
export const RISKY_WAIT_MS = 5 * 60_000;

const LETTER = "[\\p{L}\\p{M}\\p{N}]";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WHOLE = [...RISKY_WORDS.en, ...RISKY_WORDS.vi].map((word) => ({ word, pattern: new RegExp(`(?<!${LETTER})${escape(word).replace(/ /g, "\\s+")}(?!${LETTER})`, "iu") }));

/** The risky word or phrase a control's name holds, if any. */
export function riskyWord(name: string): string | undefined {
    const text = name.normalize("NFC");

    return WHOLE.find((each) => each.pattern.test(text))?.word ?? RISKY_WORDS.zh.find((word) => text.includes(word));
}

/** The risky word of a form's address (`https://shop.test/checkout/confirm`), if any. */
export function riskyAddress(address: string): string | undefined {
    let words: string[];

    try {
        const url = new URL(address);

        words = `${url.pathname} ${url.search}`.toLowerCase().split(/[^a-z0-9]+/);
    } catch {
        words = address.toLowerCase().split(/[^a-z0-9]+/);
    }

    return RISKY_ADDRESS_WORDS.find((word) => words.includes(word));
}

/** What a submit would send, as the page tells it: the form's address and its submit button's name. */
export type Submit = { action: string; button: string };

/** Why a control is risky: the word, and where it was found (its own name, its form's submit button, its form's address). */
export type Risk = { word: string; found: "name" | "button" | "address" };

/** Why a control is risky, or undefined. `submit`: the form a click or Enter submits. */
export function riskOf(name: string, submit?: Submit): Risk | undefined {
    const own = riskyWord(name);

    if (own !== undefined) {
        return { word: own, found: "name" };
    }

    if (submit === undefined) {
        return undefined;
    }

    const button = riskyWord(submit.button);

    if (button !== undefined) {
        return { word: button, found: "button" };
    }

    const address = riskyAddress(submit.action);

    return address === undefined ? undefined : { word: address, found: "address" };
}

/** A risk in Pi's words: `pay`, `place order, its form's button`, `checkout, in the address its form goes to`. */
export function riskWords(risk: Risk): string {
    return risk.found === "name" ? risk.word : risk.found === "button" ? `${risk.word}, its form's button` : `${risk.word}, in the address its form goes to`;
}

/** One action of Pi's that waits for the owner: the tool, the control (in the page's or app's words), why, and where. */
export type RiskyStep = { tool: string; control: string; risk: Risk; where: string; place: "browser" | "computer" };

/** Asks the owner about one risky action: true to go ahead once, or the words that say why not. */
export type Approve = (step: RiskyStep) => Promise<true | string>;

/** A risky action the owner did not approve: nothing was done. */
export class RiskyRefused extends Error {}

/** Who answers a card that timed out, in its answer. */
const TIMED_OUT = "nobody (timed out)";

/** A tool call, as a card names it. */
export type CardCall = { conversationId: unknown; taskId: unknown; callId?: string };

/**
 * One card for the owner (PP-455, PP-456): `id`, and what it shows. Answers true when the owner approved; otherwise the
 * words that say why not (`not owner` when the session does not work for the owner, no card then; a Deny; nobody
 * answering within `wait` ms, when the card goes).
 */
export async function ownerCard(
    host: Pick<PocketHost, "approvals" | "requesterOf" | "people">,
    call: CardCall,
    context: unknown,
    card: Pick<ApprovalRequest, "id" | "tool" | "subject" | "reason" | "form">,
    notOwner: string,
    wait: number,
): Promise<true | string> {
    const requester = host.requesterOf(call.conversationId as ConversationId);
    const owner = host.people().find((person) => person.id === requester)?.role === "owner";

    if (!owner) {
        return notOwner;
    }

    const timer = setTimeout(() => host.approvals.answer(card.id, { allow: false, by: TIMED_OUT }), wait);

    try {
        const answer = await host.approvals.request(
            {
                ...card,
                conversationId: call.conversationId as ConversationId,
                taskId: call.taskId as TaskId,
                ...(call.callId === undefined ? {} : { callId: call.callId }),
                createdAt: Date.now(),
            },
            context as never,
        );

        if (answer.allow) {
            return true;
        }

        const span = wait % 60_000 === 0 ? `${wait / 60_000} minutes` : `${wait / 1000} seconds`;

        return answer.by === TIMED_OUT ? `Nobody answered the owner's card within ${span}, so it was denied:` : `${answer.by} denied it on the card:`;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The `Approve` of one tool call: each risky action of it a card of its own (`risky-<task>-<call>-<n>`), answered by
 * the owner with Approve once or Deny. Not the owner's session, or no answer in `wait` ms: denied, said why.
 */
export function approveFor(host: Pick<PocketHost, "approvals" | "requesterOf" | "people">, call: CardCall, context: unknown, wait = RISKY_WAIT_MS): Approve {
    let asked = 0;

    return (step) => {
        asked += 1;

        return ownerCard(
            host,
            call,
            context,
            {
                id: `risky-${String(call.taskId)}-${String(call.callId)}-${asked}`,
                tool: step.tool,
                subject: step.control,
                reason: `It may pay, send, book or delete (${riskWords(step.risk)}). Approve once lets this one action go ahead; Deny stops it.`,
                form: { type: "risky", control: step.control, word: step.risk.word, found: step.risk.found, where: step.where, place: step.place },
            },
            "Only the owner approves a step that may pay, send, book or delete, and this session does not work for the owner: denied.",
            wait,
        );
    };
}

// The owner's card before paying, sending, booking or deleting (PP-455, src/server/risky.ts), for tests that act on
// Pi's browser or a computer directly: NO_CARD where no card may come, `approving()` where one should.
import assert from "node:assert/strict";
import type { Approve, RiskyStep } from "../src/server/risky.ts";

/** A card here fails the test: the action was not expected to ask. */
export const NO_CARD: Approve = async (step) => assert.fail(`no card was expected, but Pi asked about ${step.control} (${step.risk.word})`);

/** computer control's `ask` with NO_CARD. */
export const NO_ASK = { tool: "computer_act", approve: NO_CARD };

/** Answers every card with `answer` (true: Approve once; text: why not), keeping what each asked about. */
export function answering(answer: true | string = true): Approve & { asked: RiskyStep[] } {
    const asked: RiskyStep[] = [];
    const approve = async (step: RiskyStep) => {
        asked.push(step);

        return answer;
    };

    return Object.assign(approve, { asked });
}

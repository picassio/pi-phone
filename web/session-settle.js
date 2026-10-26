// When a session settles (out of the active list, in the folded Settled shelf), after T3 Code's sidebar. Pure, so a test
// can import it (`test/session-settle.test.ts`); `sessions.js` gives it the person's pins.

/** How long a session sits idle before it settles by itself (owner's choice: a day). */
export const SETTLE_IDLE_MS = 86_400_000;
/** Activity this soon after a session settled is its run's own end, not something new. */
const SETTLE_GRACE_MS = 10_000;

/**
 * Why a session is settled, or null while it is active: settled by hand or by an extension (a task session whose run
 * ended, a merged branch) until something happens there again, or idle for a day. Work going on, or a call waiting for
 * you, keeps it active; Un-settle keeps it up for another day. A pinned session never settles by being idle: the person
 * pinned it to keep it at the top (the owner, 2026-10-26: "pinned, but pushed into Settled"); settling it by hand unpins
 * it first.
 */
export function settledOf(session, now = Date.now(), pinned = false) {
    if (session.busy || session.waiting || session.archived) {
        return null;
    }

    const settle = session.settle;
    const updated = session.updatedAt ?? 0;

    if (settle?.state === "settled" && updated <= settle.at + SETTLE_GRACE_MS) {
        return settle.reason ?? "settled";
    }

    if (pinned) {
        return null;
    }

    const touched = Math.max(updated, settle?.state === "active" ? settle.at : 0);

    return now - touched > SETTLE_IDLE_MS ? "idle a day" : null;
}

/** When a settled session settled, for the shelf's order. */
export const settledAt = (session) => (session.settle?.state === "settled" ? session.settle.at : (session.updatedAt ?? 0) + SETTLE_IDLE_MS);

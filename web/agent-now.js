// What a working subagent does this moment, from its peek: the call it waits on, the call it runs, or its words. The
// subagents bar and the peek tiles both say it, for a row each.
import { describeCall } from "./calls.js";
import { t } from "./i18n.js";
import { fromServer } from "./seen.js";
import { store } from "./store.js";
import { formatWhen } from "./ui.js";

/** What a working subagent does this moment: its peek's waiting call, running call, or words. */
export function nowDoing(agent, peek = store.state.peeks?.[agent.conversationId]) {
    // Its request waits for its provider's limit to clear: that is what it does, whatever its peek last showed.
    if (agent.limited !== undefined) {
        return t("Waiting for a limit · next try {time}", { time: formatWhen(fromServer(agent.limited)) });
    }

    const waiting = peek?.approvals?.[0];

    if (waiting) {
        return `Waiting for approval: ${waiting.tool} ${waiting.subject}`.trim();
    }

    const last = (peek?.lines ?? []).at(-1);

    if (last?.kind === "tool" && last.status === "running") {
        const call = describeCall({ name: last.name, args: last.args });

        return [call.icon, call.label, call.subject].filter(Boolean).join(" ");
    }

    if (last?.kind === "shell") {
        return `$ ${last.command}`;
    }

    if (last?.kind === "text") {
        return last.text;
    }

    // Before its peek arrives, nothing is known but that it works.
    return peek === undefined ? "Working…" : "Thinking…";
}

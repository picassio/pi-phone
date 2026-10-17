/**
 * Everything at work right now, from Pi Durable's task graph: answers being written, tool calls, compactions,
 * and subagents, with the calls waiting for approval, grouped by the session they belong to.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskGraphNode } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SubagentsDoc } from "./docs.ts";
import { COMMAND_TASK } from "./extension-commands.ts";

const context = BACKGROUND_CONTEXT;

export type RunningTask = {
    id: number;
    /** The task kind as Pi Durable names it, such as `pi.tool`. */
    kind: string;
    /** What it does, in words. */
    label: string;
    status: string;
    /** The conversation it works in: the session, or one of its subagents. */
    conversationId: number;
    /** A subagent's name, when the task works in one. */
    subagent?: string;
};

export type RunningSession = {
    id: number;
    title: string;
    busy: boolean;
    approvals: number;
    tasks: RunningTask[];
};

/** The live tasks, as one read of the task graph. */
async function liveTasks(app: PocketApp): Promise<TaskGraphNode[]> {
    const graph = await app.harness.taskGraph(context);

    try {
        return Object.values(graph.value.tasks);
    } finally {
        graph.dispose();
    }
}

/** What a task does, in words, from what its conversation's documents say about it. */
async function describeTask(
    app: PocketApp,
    node: TaskGraphNode,
    user: User,
): Promise<Pick<RunningTask, "label"> | undefined> {
    const id = node.conversationId;

    switch (node.kind) {
        case "pi.generation":
            return { label: "writing an answer" };

        case "pi.tool": {
            const slot = (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find(
                (each) => each.taskId === node.id,
            );

            return { label: slot === undefined ? "running a tool" : `running ${slot.name}` };
        }

        case "pi.compaction":
            return { label: "compacting the context" };
        case "pocket.subagent-reporter":
            return { label: "waiting for a subagent's answer" };
        case "pocket.follow-failure":
            return { label: "waiting for a failed subagent to answer a message" };

        case "pocket.subagent-courier": {
            const held = (await app.harness.snapshot(SubagentsDoc, id, context))?.held;

            return {
                label:
                    held === undefined
                        ? "taking subagents' reports to Pi at its next pause"
                        : `holding subagents' reports: ${held}`,
            };
        }

        case COMMAND_TASK: {
            const command = await app.extensionCommands.named(node.id);

            if (command?.scope !== "conversation" && user.role !== "owner") {
                return undefined;
            }

            return {
                label:
                    command === undefined
                        ? "running an extension command"
                        : `running /${command.name}`,
            };
        }

        case "pocket.shell": {
            const command = await app.shell.describe(node.id);

            return { label: command === undefined ? "running a command" : `running ${command}` };
        }

        default:
            return { label: node.kind };
    }
}

/** The sessions this person can see that have something at work, busiest first. */
export async function runningNow(app: PocketApp, user: User): Promise<RunningSession[]> {
    const sessions = new Map<ConversationId, RunningSession>();

    const session = async (conversationId: ConversationId): Promise<RunningSession> => {
        const root = app.rootOf(conversationId);
        let entry = sessions.get(root);

        if (entry === undefined) {
            entry = {
                id: Number(root),
                title: await app.conversationTitle(root),
                busy: false,
                approvals: 0,
                tasks: [],
            };
            sessions.set(root, entry);
        }

        if (app.isBusy(conversationId)) {
            entry.busy = true;
        }

        return entry;
    };

    for (const node of await liveTasks(app)) {
        // A subagent's anchor stays for as long as the subagent does, doing nothing: its work shows on its own.
        if (node.kind === "pocket.subagent-anchor" || !app.canSee(user, node.conversationId)) {
            continue;
        }

        const description = await describeTask(app, node, user);

        if (description === undefined) {
            continue;
        }

        const parent = app.parentOf(node.conversationId);
        const subagent =
            parent === undefined
                ? undefined
                : Object.entries(
                      (await app.harness.snapshot(SubagentsDoc, parent, context))?.agents ?? {},
                  ).find(([, record]) => record.conversationId === node.conversationId)?.[0];

        (await session(node.conversationId)).tasks.push({
            id: Number(node.id),
            kind: node.kind,
            status: node.state.status,
            conversationId: Number(node.conversationId),
            ...(subagent === undefined ? {} : { subagent }),
            ...description,
        });
    }

    for (const approval of app.approvals.all()) {
        if (app.canSee(user, approval.conversationId)) {
            (await session(approval.conversationId)).approvals++;
        }
    }

    return [...sessions.values()].sort(
        (a, b) => Number(b.busy) - Number(a.busy) || b.tasks.length - a.tasks.length,
    );
}

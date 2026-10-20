/**
 * Signed-in devices for Pi (a tool for everything: Settings › People › Devices has them). Pi lists them as the person
 * it works for sees them (the owner everyone's, others their own), and signs one out, or every other one of theirs,
 * only after that person says yes on a card.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

const ago = (at: number | undefined) => {
    if (at === undefined) {
        return "never";
    }

    const minutes = Math.round((Date.now() - at) / 60_000);

    return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};

export default function createDevices(host: PocketHost) {
    /** Who Pi works for here, or why it cannot act. */
    const person = (conversationId: unknown): string => {
        const requester = host.requesterOf(Number(conversationId) as never);

        if (requester === undefined || !host.people().some((each) => each.id === requester)) {
            throw new Error("No one Pi works for here is signed in to pi-phone.");
        }

        return requester;
    };
    const ask = (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, subject: string, reason: string) =>
        host.approvals.request(
            {
                id: `${tool}-${String(api.conversationId)}-${String(api.callId)}`,
                conversationId: Number(api.conversationId) as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool,
                subject,
                reason,
                createdAt: Date.now(),
            },
            context as never,
        );

    const tools = [
        defineTool({
            name: "devices",
            description:
                "The devices signed in to pi-phone (Settings › People › Devices): the owner's and, for the owner, invited people's. Each with its id, whose it is, what it is, where it was last seen, and whether a tab of it is open now.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api) => {
                try {
                    const devices = host.devices(person(api.conversationId));

                    return reply(
                        devices.length === 0
                            ? "No devices are signed in."
                            : devices
                                  .map(
                                      (device) =>
                                          `${device.id} · ${device.user.name}${device.user.role === "owner" ? " (owner)" : ""} · ${device.name}${device.app ? " (this phone's app)" : ""} · ${device.address ?? "address unknown"} · ${device.open ? "open now" : `last active ${ago(device.lastSeen)}`} · signed in ${new Date(device.createdAt).toISOString().slice(0, 10)}`,
                                  )
                                  .join("\n"),
                    );
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
        defineTool({
            name: "device_sign_out",
            description:
                "Sign one device out of pi-phone, by its id from devices: its tabs close and it must sign in again (this phone's app signs in again by itself). Asks the person on a card first.",
            parameters: Type.Object({ id: Type.String({ description: "The device's id, from devices" }) }),
            execute: async (args, api, context) => {
                try {
                    const userId = person(api.conversationId);
                    const device = host.devices(userId).find((each) => each.id === args.id);

                    if (device === undefined) {
                        return reply(`There is no device ${args.id} you may sign out: list them with devices.`, true);
                    }

                    const answer = await ask(api, context, "device_sign_out", `Sign out ${device.name} (${device.user.name})`, `Last seen at ${device.address ?? "an unknown address"}, ${device.open ? "open now" : `last active ${ago(device.lastSeen)}`}. Its tabs close at once.`);

                    if (!answer.allow) {
                        return reply(`${answer.by} said no: ${device.name} stays signed in.`, true);
                    }

                    host.signOutDevice(userId, device.id);

                    return reply(`Signed out ${device.name} (${device.user.name}).`);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
        defineTool({
            name: "sign_out_everywhere",
            description:
                "Sign out every device of the person Pi works for (for the owner, this also replaces the owner token; invited people's devices stay). This phone's app signs in again by itself; every other device must sign in again. Asks the person on a card first.",
            parameters: Type.Object({}),
            execute: async (_args, api, context) => {
                try {
                    const userId = person(api.conversationId);
                    const mine = host.devices(userId).filter((device) => device.user.id === userId);
                    const owner = host.people().find((each) => each.id === userId)?.role === "owner";
                    const answer = await ask(
                        api,
                        context,
                        "sign_out_everywhere",
                        `Sign out all ${mine.length} of your devices`,
                        `${owner ? "The owner token is replaced too. " : ""}This phone's app signs in again by itself; laptops and other browsers must sign in again.`,
                    );

                    if (!answer.allow) {
                        return reply(`${answer.by} said no: every device stays signed in.`, true);
                    }

                    host.signOutEverywhere(userId);

                    return reply(`Signed out every device${owner ? ", and replaced the owner token" : ""}.`);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
    ];

    return defineExtension({ name: "pocket-devices", tools });
}

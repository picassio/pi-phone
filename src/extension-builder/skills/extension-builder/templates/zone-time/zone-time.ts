/**
 * Zone time: the time now in any time zone, as a tool Pi can call.
 *
 * Template (pi-phone's extension-builder skill): a drop-in with one tool and no browser part. The tool only reads, so it
 * says so (`readOnlyHint`) and plan mode lets it run.
 */
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** The version of pi-phone's extension API this module is written for. */
export const pocketApi = 2;

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

const zoneTime = Object.assign(
    defineTool({
        // A tool's name is the drop-in's own: never one of pi-phone's (extension_inspect lists them), or the drop-in is refused.
        name: "zone_time",
        description: "The date and time now in a time zone, such as Asia/Saigon or Europe/Berlin.",
        parameters: obj({
            zone: str({ description: "An IANA time zone, like Asia/Saigon" }),
        }),
        // Running it again after a restart is harmless.
        replay: "safe",
        execute: async (args) => {
            try {
                const text = new Intl.DateTimeFormat("en-GB", { timeZone: args.zone, dateStyle: "full", timeStyle: "long" }).format(new Date());

                return reply(`${args.zone}: ${text}`);
            } catch {
                // Say what is wrong and how to put it right: Pi reads this.
                return reply(`${args.zone} is not a time zone: give an IANA name, like Asia/Saigon.`, true);
            }
        },
    }),
    // It only reads: plan mode lets it run.
    { annotations: { readOnlyHint: true } },
);

export default function createZoneTime() {
    return defineExtension({ name: "zone-time", tools: [zoneTime] });
}

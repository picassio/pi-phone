/**
 * Pi makes drop-in extensions from a chat request: a skill with the drop-in API, the app's UI rules, and templates.
 *
 * The Extension builder extension (PP-367). While it is on, phone and server sessions list the `extension-builder`
 * skill (`BUILDER_SKILLS` in `extension-builder.ts`): how a drop-in is made (a server part and a browser part), checked,
 * installed with `extension_install` (the owner's card), turned on by the owner, and looked at in the live app. Off:
 * no session lists it. What it makes still lands switched off, for the owner to turn on.
 *
 * Its tool `extension_inspect` (PP-368) only reads (plan mode lets it run): without a name, the drop-in API's names (the
 * kinds a browser part adds, `pocket`'s members, the icons, the theme's CSS variables) and the names a drop-in may not
 * take; with a module's name, how it stands, why it failed or was refused, what it added, and what tabs reported of its
 * browser part (`extension-inspect.ts`). Never a file's contents or a secret.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BUILDER_EXTENSION } from "../extension-builder.ts";
import { inspect, overview } from "../extension-inspect.ts";
import type { PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

export default function createExtensionBuilder(host: PocketHost) {
    const inspectTool = defineTool({
        name: "extension_inspect",
        description:
            "Read how drop-in extensions stand, without changing anything. Without a name: the drop-in API's names (what a browser part adds, pocket's members, the icons, the theme's CSS variables), the tool and module names a drop-in may not take, and each drop-in's state. With a module's name (the owner's): its files (names only), on or off, loaded, failed or refused and why, what it added (tools, sections, routes, its browser part), and what tabs reported of its browser part (its rail, page and sheet ids, its newest error).",
        parameters: Type.Object({
            name: Type.Optional(Type.String({ description: "An extension module's name, like checklist or checklist.ts" })),
        }),
        replay: "safe",
        execute: async (args, api) => {
            try {
                const asker = host.requesterOf(Number(api.conversationId) as never);
                const owner = asker !== undefined && host.person(asker).role === "owner";

                if (args.name === undefined || args.name.trim() === "") {
                    return reply(overview(host.extensionModules, owner));
                }

                // A module's errors can name the server's folders: the owner's, as the Extensions sheet's are.
                if (!owner) {
                    return reply("extension_inspect of one module is the owner's: its errors can name the server's folders. Without a name it lists the drop-in API.", true);
                }

                return reply(inspect(host.extensionModules, args.name));
            } catch (error) {
                return reply(error instanceof Error ? error.message : String(error), true);
            }
        },
    });

    return defineExtension({ name: BUILDER_EXTENSION, tools: [inspectTool] });
}

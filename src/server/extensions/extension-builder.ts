/**
 * Pi makes drop-in extensions from a chat request: a skill with the drop-in API, the app's UI rules, and templates.
 *
 * The Extension builder extension (PP-367). While it is on, phone and server sessions list the `extension-builder`
 * skill (`BUILDER_SKILLS` in `extension-builder.ts`): how a drop-in is made (a server part and a browser part), checked,
 * installed with `extension_install` (the owner's card), turned on by the owner, and looked at in the live app. Off:
 * no session lists it. What it makes still lands switched off, for the owner to turn on.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { BUILDER_EXTENSION } from "../extension-builder.ts";

export default function createExtensionBuilder() {
    return defineExtension({ name: BUILDER_EXTENSION });
}

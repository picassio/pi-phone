/**
 * Slash commands from pstack: /interrogate, /blast-radius, /ketchup, /reflect, /correct, /why, /how, /teach and more.
 *
 * The pstack commands extension (PP-550), on by default (the owner's choice, PP-551). While it is on, every session on
 * the phone and in the server edition lists thirteen of pstack's skills as `/skill:<name>` commands (`PSTACK_SKILLS`
 * in `pstack.ts`), adapted to pi-phone's tools. Each runs only when someone types it: none is in the system prompt.
 * Off: no session lists them.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { PSTACK_EXTENSION } from "../pstack.ts";

export default function createPstack() {
    return defineExtension({ name: PSTACK_EXTENSION });
}

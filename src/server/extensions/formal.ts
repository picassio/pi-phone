/**
 * Check TLA+ models with TLC and draw them as Mermaid statecharts, with the shortest path to each broken rule.
 *
 * The Formal checks extension (PP-316). While it is on, the app lists pstack's statechart skill in every session on the
 * phone and in the server edition (`FORMAL_SKILLS` in `formal-checks.ts`), and in sessions on a machine with the TLC
 * machine tool, which put a copy of the skill there. TLC runs where Java is: a machine with the tool (bash there has
 * `TLA2TOOLS` and `JAVA`) or the server edition's image. Off: no session lists the skill.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { FORMAL_EXTENSION } from "../formal-checks.ts";

export default function createFormal() {
    return defineExtension({ name: FORMAL_EXTENSION });
}

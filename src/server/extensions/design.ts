/**
 * Design systems, slide deck templates, motion, and business films for Pi's pages, artifacts, and Office files.
 *
 * The Design & video extension (PP-247). While it is on, the app adds its skills to every phone session
 * (`DESIGN_SKILLS` in `design-systems.ts`: design-system, OpenDesign's five deck templates and five GSAP skills, Motion
 * Video Kit's business-motion-film), the `design.default` setting is offered (Menu › Design system), and this module's
 * `design_system` prompt section names the default design system. Off: none of these, so sessions carry no extra
 * skill descriptions.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { DESIGN_EXTENSION } from "../design-systems.ts";

export default function createDesign(host: PocketHost) {
    return defineExtension({
        name: DESIGN_EXTENSION,
        sections: [
            // On the phone only, where the design systems' files are (a session on a machine has none of these skills).
            section("design_system", (input) => (host.machineOf(input.agent.cwd ?? input.env?.cwd ?? process.cwd()) === undefined ? host.designSystem() : undefined)),
        ],
    });
}

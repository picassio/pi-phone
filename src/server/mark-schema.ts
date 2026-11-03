/**
 * What a mark on a picture may say (PP-119, `markup.ts`), for `browser_screenshot` (on controls, texts or areas of the
 * view) and `image_markup` (on areas of a picture file).
 */
import { bool, int, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "./tool-schema.ts";
import { MARK_COLORS } from "./markup.ts";

export const MARK_STYLE = {
    box: opt(bool({ description: "An outline around it (default true, unless hidden)" })),
    number: opt(int({ minimum: 0, maximum: 999, description: "A numbered badge on its corner, for steps" })),
    label: opt(str({ maxLength: 80, description: "A short label beside it" })),
    arrow: opt(bool({ description: "An arrow pointing at it" })),
    hide: opt(union([literal("solid"), literal("blur")], {
            description: "Hide it: solid for keys, tokens, passwords and other secrets (nothing can be recovered); blur for names, emails and the like",
        })),
    spotlight: opt(bool({ description: "Keep it lit and dim the rest of the picture" })),
    color: opt(str({ description: `The mark's color: ${MARK_COLORS.join(", ")}, or #rrggbb (default red)` })),
};

export const AREA = obj({ x: num(), y: num(), width: num({ exclusiveMinimum: 0 }), height: num({ exclusiveMinimum: 0 }) }, { open: true });

export const MARKS_NOTE =
    "Marks: point at things with a box, a numbered badge (steps), a label and an arrow; dim the rest with spotlight; hide secrets with hide (solid for keys, tokens and passwords, blur for names and emails). Choose colors that stand out on the page.";

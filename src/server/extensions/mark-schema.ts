/**
 * What a mark on a picture may say (PP-119, `markup.ts`), for `browser_screenshot` (on controls, texts or areas of the
 * view) and `image_markup` (on areas of a picture file).
 */
import { Type } from "@earendil-works/pi-ai";
import { MARK_COLORS } from "../markup.ts";

export const MARK_STYLE = {
    box: Type.Optional(Type.Boolean({ description: "An outline around it (default true, unless hidden)" })),
    number: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "A numbered badge on its corner, for steps" })),
    label: Type.Optional(Type.String({ maxLength: 80, description: "A short label beside it" })),
    arrow: Type.Optional(Type.Boolean({ description: "An arrow pointing at it" })),
    hide: Type.Optional(
        Type.Union([Type.Literal("solid"), Type.Literal("blur")], {
            description: "Hide it: solid for keys, tokens, passwords and other secrets (nothing can be recovered); blur for names, emails and the like",
        }),
    ),
    spotlight: Type.Optional(Type.Boolean({ description: "Keep it lit and dim the rest of the picture" })),
    color: Type.Optional(Type.String({ description: `The mark's color: ${MARK_COLORS.join(", ")}, or #rrggbb (default red)` })),
};

export const AREA = Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) });

export const MARKS_NOTE =
    "Marks: point at things with a box, a numbered badge (steps), a label and an arrow; dim the rest with spotlight; hide secrets with hide (solid for keys, tokens and passwords, blur for names and emails). Choose colors that stand out on the page.";

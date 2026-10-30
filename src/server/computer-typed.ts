/**
 * What the owner typed on a computer_sign_in card (PP-183) stays out of everything Pi gets of the window afterwards, as
 * Pi's browser keeps a card's values out of its reads (PP-93, PP-228): in ocu's text each value reads as its mask
 * (`[username for <app>]`, `[password for <app>]`, `[code for <app>]`), and in a picture a model gets, the field it went
 * into and every element showing it are blacked out. A value too short to find by its text (under `MIN_TYPED_HIDDEN`
 * characters) in a field that shows what it holds withholds the window while it shows there.
 */
import type { ComputerOutline, Frame } from "./computer-outline.ts";

/** The shortest value text hiding covers: a shorter one would hide every "42" in the window. */
export const MIN_TYPED_HIDDEN = 3;

/** A value from a card: the field it went into (what that element is), the value, and what Pi reads in its place. */
export type TypedFill = { what: string; value: string; password: boolean; mask: string };

/** What Pi gets instead of the window while a short value from a card shows in it (`shortTypedShowing`). */
export const SHORT_TYPED_NOTE =
    "The window is not shown: a field shows what the owner typed on the card, too short to hide from you. Submit it (computer_act press_key Return, or a click on the sign-in button by its number from your read before the card), or ask the owner to; then read the window again.";

/** `text` with every value from a card (long enough to find) read as its mask, the longest first. */
export function hideTyped(text: string, fills: readonly TypedFill[]): string {
    return [...fills]
        .filter((fill) => fill.value.length >= MIN_TYPED_HIDDEN)
        .sort((a, b) => b.value.length - a.value.length)
        .reduce((hidden, fill) => hidden.split(fill.value).join(fill.mask), text);
}

/** Whether a short value from a card shows in a field that shows what it holds (not a password field). */
export function shortTypedShowing(fills: readonly TypedFill[], outline: ComputerOutline): boolean {
    return fills.some((fill) => !fill.password && fill.value.length < MIN_TYPED_HIDDEN && outline.elements.some((element) => element.what === fill.what && element.value === fill.value));
}

/**
 * Where a picture of the window is blacked out, in window points: each field a card's value went into (by what it is),
 * and every element whose name or value shows a value (a label that greets the username).
 */
export function typedAreas(fills: readonly TypedFill[], outline: ComputerOutline): Frame[] {
    if (fills.length === 0) {
        return [];
    }

    const values = fills.map((fill) => fill.value).filter((value) => value.length >= MIN_TYPED_HIDDEN);

    return outline.elements
        .filter((element) => element.index !== 0 && element.frame !== undefined)
        .filter((element) => fills.some((fill) => fill.what === element.what) || values.some((value) => element.name.includes(value) || (element.value ?? "").includes(value)))
        .map((element) => element.frame!);
}

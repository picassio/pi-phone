/**
 * `/make` and `/page` (PP-428): the Creator flow (PP-369) and artifact pages (PP-370) as slash commands. Like `/review`
 * (`expandReviewCommand`, `review.ts`), the server turns each into what Pi gets: the command as typed (what the
 * transcript shows), then what to do in a `<make-request>` or `<page-request>` the transcript hides. Pi's prompt does
 * not grow: the words come with the message, only when someone uses the command.
 *
 * A prompt template of the same name wins (`submit` in `commands.ts` asks for this only when there is none).
 */

/** What the commands need on this server, and the conversation the message goes to (for `pages.keep`). */
export type CreatorCommandPlace = {
    /** The Extension builder extension is on (`BUILDER_EXTENSION`): `extension_create` is there. */
    builder: boolean;
    /** Artifacts are on, and so are pages kept from them (the setting `artifacts.pages`). */
    pages: boolean;
    conversation: number;
};

/** Why a command was not expanded: what it needs is `off`, or nothing follows it (`empty`). `submit` says it to the person. */
export type CreatorCommandError = { error: "off" | "empty"; command: "make" | "page" };

/**
 * `/make <what>` or `/page <what>` as Pi gets it; undefined when the text is neither, an error when it cannot go.
 */
export function expandCreatorCommand(text: string, place: CreatorCommandPlace): string | CreatorCommandError | undefined {
    const match = /^\/(make|page)(?:\s+([\s\S]*))?$/.exec(text);

    if (match === null) {
        return undefined;
    }

    const name = match[1] as "make" | "page";

    if (!(name === "make" ? place.builder : place.pages)) {
        return { error: "off", command: name };
    }

    if ((match[2] ?? "").trim() === "") {
        return { error: "empty", command: name };
    }

    const request =
        name === "make"
            ? "Make what the line above asks as a drop-in extension, with the Creator flow: read the extension-builder skill, call extension_create for it, then go on as the skill says (extension_made install, the owner switches it on, look at it in the live app, extension_made checked)."
            : `Build what the line above asks as an artifact with the artifact tool. Fix what the layout check finds (the publish answer has its numbers; else run screenshot). Then offer to keep it as a page on the person's rail: app_action pages.keep with session ${place.conversation}, the artifact's id and kept on (their card decides).`;

    return `${text}\n\n<${name}-request>\n${request}\n</${name}-request>`;
}

/**
 * Checklist: a short list of things to do that you and Pi share, as a page for you and tools for Pi.
 *
 * Template (pi-phone's extension-builder skill): one operation, two callers. The page (through the module's routes,
 * `/api/x/checklist/…`) and Pi (through its tools) change the list with the same functions here, and every change goes
 * to the page as an event, so it shows what Pi did at once. Its data is kept outside the drop-in's folder, which an
 * update replaces.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** The version of pi-phone's extension API this module is written for. */
export const pocketApi = 2;

type Item = { id: string; text: string; done: boolean };

/** The parts of the `host` and `web` arguments this module uses. */
type Host = { readonly dataDir: string };
type Request = { readonly body: Readonly<Record<string, unknown>>; readonly params: Readonly<Record<string, string>> };
type Web = {
    route(method: "GET" | "POST" | "DELETE", path: string, handle: (request: Request) => unknown): void;
    client(entry: string): void;
    send(event: string, data?: unknown): void;
    error(status: number, message: string): Error;
};

const MAX_ITEMS = 200;
const MAX_TEXT = 300;

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function createChecklist(host: Host, web: Web) {
    const folder = join(host.dataDir, "extension-data", "checklist");
    const file = join(folder, "items.json");

    // ─── The operations: the one place the list changes ───

    const list = (): Item[] => {
        try {
            return JSON.parse(readFileSync(file, "utf8")) as Item[];
        } catch (error) {
            // None yet is an empty list; a file that cannot be read is an error, said as it is.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }

            throw error;
        }
    };

    const save = (items: Item[]): Item[] => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(items, null, 2));
        renameSync(`${file}.tmp`, file);
        // The page hears it (`pocket.on("changed", …)`), whoever made the change.
        web.send("changed", { items });

        return items;
    };

    const find = (items: Item[], id: string): Item => {
        const item = items.find((each) => each.id === id);

        if (item === undefined) {
            throw new Error(`There is no item ${id} on the checklist.`);
        }

        return item;
    };

    const add = (text: string): Item[] => {
        const items = list();
        const clean = text.trim();

        if (clean === "" || clean.length > MAX_TEXT) {
            throw new Error(`An item is 1 to ${MAX_TEXT} characters.`);
        }

        if (items.length >= MAX_ITEMS) {
            throw new Error(`The checklist holds ${MAX_ITEMS} items at most: remove some first.`);
        }

        return save([...items, { id: randomUUID().slice(0, 8), text: clean, done: false }]);
    };

    const setDone = (id: string, done: boolean): Item[] => {
        const items = list();

        find(items, id).done = done;

        return save(items);
    };

    const remove = (id: string): Item[] => {
        const items = list();

        find(items, id);

        return save(items.filter((each) => each.id !== id));
    };

    // ─── The page's caller: routes under /api/x/checklist/ (the owner's alone, as access is not given) ───

    const answer = (run: () => Item[]) => {
        try {
            return { items: run() };
        } catch (error) {
            // Its words reach the page as they are.
            throw web.error(400, message(error));
        }
    };

    web.route("GET", "items", () => answer(list));
    web.route("POST", "items", (request) => answer(() => add(String(request.body.text ?? ""))));
    web.route("POST", "items/:id", (request) => answer(() => setDone(request.params.id ?? "", request.body.done === true)));
    web.route("DELETE", "items/:id", (request) => answer(() => remove(request.params.id ?? "")));
    web.client("checklist");

    // ─── Pi's caller: tools with the same meaning ───

    const lines = (items: Item[]) =>
        items.length === 0 ? "The checklist is empty." : items.map((item) => `- [${item.done ? "x" : " "}] ${item.id}: ${item.text}`).join("\n");

    const checklistList = Object.assign(
        defineTool({
            name: "checklist_list",
            description: "The shared checklist: each item's id, whether it is done, and its text.",
            parameters: obj({}),
            replay: "safe",
            execute: async () => {
                try {
                    return reply(lines(list()));
                } catch (error) {
                    return reply(message(error), true);
                }
            },
        }),
        { annotations: { readOnlyHint: true } },
    );

    const checklistChange = defineTool({
        name: "checklist_change",
        description: "Change the shared checklist the person sees on its page: add an item, mark one done or not done, or remove one (ids from checklist_list).",
        parameters: obj({
            action: oneOf(["add", "done", "undone", "remove"]),
            text: opt(str({ description: "add: the item's text" })),
            id: opt(str({ description: "done, undone, remove: the item's id" })),
        }),
        execute: async (args) => {
            try {
                const items =
                    args.action === "add"
                        ? add(args.text ?? "")
                        : args.action === "remove"
                          ? remove(args.id ?? "")
                          : setDone(args.id ?? "", args.action === "done");

                return reply(lines(items));
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    return defineExtension({ name: "checklist", tools: [checklistList, checklistChange] });
}

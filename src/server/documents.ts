/**
 * Documents to Markdown with markit (`markit-engine`, our fork of shift-labs-ai/markit with an Android build): PDF,
 * Word, PowerPoint, Excel, EPUB, Jupyter notebooks, CSV, RSS, and ZIPs of them. Used for files attached to a message
 * (`commands.ts`), `file_to_markdown`, `fetch_content`, and `wiki_ingest`. One engine, loaded the first time.
 */
import { Markit } from "markit-engine";
import { extname } from "node:path";

/** What markit reads, by extension. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".xls",
    ".epub",
    ".ipynb",
    ".csv",
    ".tsv",
    ".rss",
    ".atom",
    ".zip",
]);

/** Content types that mean one of them. */
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "application/epub+zip": ".epub",
    "application/x-ipynb+json": ".ipynb",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
    "application/rss+xml": ".rss",
    "application/atom+xml": ".atom",
    "application/zip": ".zip",
};

/** The document kind of a file, by its name or its content type; undefined for anything markit is not needed for. */
export function documentKind(name: string, type = ""): string | undefined {
    const extension = extname(name).toLowerCase();

    return DOCUMENT_EXTENSIONS.has(extension) ? extension : DOCUMENT_TYPES[type.split(";")[0]!.trim().toLowerCase()];
}

let engine: Markit | undefined;

/** A document's text as Markdown, and its title when it has one. */
export async function toMarkdown(bytes: Uint8Array, kind: string): Promise<{ markdown: string; title?: string }> {
    engine ??= new Markit();
    const converted = await engine.convert(Buffer.from(bytes), { extension: kind });

    return { markdown: converted.markdown, ...(converted.title ? { title: converted.title } : {}) };
}

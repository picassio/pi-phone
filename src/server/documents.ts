/**
 * Files to Markdown with markit (`markit-engine`, our fork of shift-labs-ai/markit with an Android build). Which files
 * are documents is markit's own answer: its converters' `accepts()`, not a list kept here. These are PDF, Word,
 * PowerPoint, Excel, Apple iWork (Pages, Numbers, Keynote), EPUB, Jupyter notebooks, CSV/TSV, RSS/Atom, HTML, ZIPs of
 * them, audio (its tags and length), and images (their EXIF, on request).
 *
 * Text that Pi reads as it is, which markit would only put in a code block, is not converted: plain text and code,
 * JSON, YAML, XML. An XML file is a feed only when its type says so. Used for files attached to a message
 * (`commands.ts`), `file_to_markdown`, `fetch_content`, and `wiki_ingest`. One engine, loaded the first time.
 */
import {
    AudioConverter,
    CsvConverter,
    DocxConverter,
    EpubConverter,
    HtmlConverter,
    ImageConverter,
    IpynbConverter,
    IWorkConverter,
    Markit,
    PdfConverter,
    PptxConverter,
    RssConverter,
    XlsxConverter,
    ZipConverter,
} from "markit-engine";
import { extname } from "node:path";

/** markit's converters for documents, by the name each answers to. Images apart: they are documents only on request. */
const DOCUMENTS = [
    new PdfConverter(),
    new DocxConverter(),
    new PptxConverter(),
    new XlsxConverter(),
    new IWorkConverter(),
    new EpubConverter(),
    new IpynbConverter(),
    new CsvConverter(),
    new RssConverter(),
    new HtmlConverter(),
    new ZipConverter(),
    new AudioConverter(),
];
const IMAGES = new ImageConverter();

/** The kinds, in words, for tools' descriptions. */
export const DOCUMENT_FORMATS =
    "PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), Apple Pages/Numbers/Keynote, EPUB, Jupyter notebooks, CSV/TSV, RSS/Atom, HTML, ZIP archives of them, audio (tags and length), and images (EXIF)";

/**
 * Which of markit's converters reads a file, by its name and content type; undefined for a file Pi reads as it is.
 * `images`: an image counts too, for its metadata (otherwise it goes to the model as a picture).
 */
export function documentKind(name: string, type = "", options: { images?: boolean } = {}): string | undefined {
    const mimetype = type.split(";")[0]!.trim().toLowerCase();
    const extension = extname(name).toLowerCase();
    const info = { filename: name, ...(extension === "" ? {} : { extension }), ...(mimetype === "" ? {} : { mimetype }) };

    // markit's feed reader takes any .xml; a plain XML file is text unless its type says it is a feed.
    if (extension === ".xml" && !/rss|atom/.test(mimetype)) {
        return undefined;
    }

    const found = DOCUMENTS.find((converter) => converter.accepts(info));

    if (found !== undefined) {
        return found.name;
    }

    return options.images && IMAGES.accepts(info) ? IMAGES.name : undefined;
}

let engine: Markit | undefined;

/** A file's Markdown, and its title when it has one: markit picks the converter by the name and type given. */
export async function toMarkdown(bytes: Uint8Array, name: string, type = ""): Promise<{ markdown: string; title?: string }> {
    engine ??= new Markit();
    const extension = extname(name).toLowerCase();
    const mimetype = type.split(";")[0]!.trim().toLowerCase();
    const converted = await engine.convert(Buffer.from(bytes), {
        filename: name,
        ...(extension === "" ? {} : { extension }),
        ...(mimetype === "" ? {} : { mimetype }),
    });

    return { markdown: converted.markdown, ...(converted.title ? { title: converted.title } : {}) };
}

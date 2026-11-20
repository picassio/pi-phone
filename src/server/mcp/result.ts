/**
 * An MCP tool's answer as Pi reads it (PP-525): its text fenced as data (`fencedMcp`), cut in the middle past 20 KB
 * with the whole text saved where the session's `read` reaches it, and its pictures checked: PNG, JPEG, GIF or WebP
 * by their first bytes (a server's word for the type is not taken), at most 4, each at most 3.7 MB as base64, 8 MB in
 * all. What is left out is said. Audio, links and other resources come as pi-mcp's one-line placeholders. The app's
 * image guard shrinks a picture past 2000 px a side before a model sees it (`image-guard.ts`), and the secrets'
 * `afterTool` hook hides their values in the text, as in every tool's result.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type CallToolResult, limitMcpContent, type McpOutputSaver, toLlmContent } from "@earendil-works/pi-mcp";
import { fencedMcp } from "../fence.ts";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BASE64 = 3_700_000;
export const MAX_IMAGES_BASE64 = 8_000_000;

const SIGNATURES: readonly { mimeType: string; matches: (bytes: Buffer) => boolean }[] = [
    { mimeType: "image/png", matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mimeType: "image/jpeg", matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mimeType: "image/gif", matches: (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")) },
    { mimeType: "image/webp", matches: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The picture's type by its first bytes, or undefined when it is none of the four. */
export function imageType(base64: string): string | undefined {
    const head = Buffer.from(base64.slice(0, 24), "base64");

    return SIGNATURES.find((signature) => signature.matches(head))?.mimeType;
}

export type McpToolOutput = { output: (TextContent | ImageContent)[]; isError: boolean; images: number };

/** The answer of the MCP tool Pi calls `tool`, ready for the model. `save` keeps the whole text of a long one. */
export async function formatResult(tool: string, result: CallToolResult, save?: McpOutputSaver): Promise<McpToolOutput> {
    const content = toLlmContent(result);
    const images: ImageContent[] = [];
    const left: string[] = [];
    let total = 0;

    for (const part of content) {
        if (part.type !== "image") {
            continue;
        }

        const type = imageType(part.data);

        if (type === undefined) {
            left.push(`a picture that is not PNG, JPEG, GIF or WebP (said to be ${part.mimeType})`);
        } else if (images.length >= MAX_IMAGES) {
            left.push(`a picture past the first ${MAX_IMAGES}`);
        } else if (part.data.length > MAX_IMAGE_BASE64) {
            left.push(`a picture of ${(part.data.length / 1_000_000).toFixed(1)} MB as base64, over ${MAX_IMAGE_BASE64 / 1_000_000} MB`);
        } else if (total + part.data.length > MAX_IMAGES_BASE64) {
            left.push(`a picture past ${MAX_IMAGES_BASE64 / 1_000_000} MB of pictures in all`);
        } else {
            total += part.data.length;
            images.push({ type: "image", data: part.data, mimeType: type });
        }
    }

    const texts = content.filter((part) => part.type === "text");
    const limited = await limitMcpContent(texts, save);
    const text = limited.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const note = left.length === 0 ? "" : `\n(Left out: ${left.join("; ")}.)`;
    const body = text === "" ? (images.length === 0 ? "(no content)" : `(${images.length === 1 ? "a picture" : `${images.length} pictures`}, no text)`) : text;

    return {
        output: [{ type: "text", text: `${fencedMcp(tool, body)}${note}` }, ...images],
        isError: result.isError === true,
        images: images.length,
    };
}

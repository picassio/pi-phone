// A reply to a passage of Pi's answer (from pi-pocket, PP-345): the passage goes first as a Markdown quote, then what
// the person wrote; the conversation shows such a message with the passage as a quote block.

/** The most of a passage that goes into a message. */
export const QUOTE_MAX = 1500;

/** A passage as quote lines ("> …"), cut at QUOTE_MAX characters. */
function quoteLines(passage) {
    const text = passage.trim().replace(/\r\n?/g, "\n");
    const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;

    return cut
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
}

/** The message to send: the quoted passage, a blank line, then the reply. */
export function withQuote(passage, reply) {
    return passage ? `${quoteLines(passage)}\n\n${reply}`.trimEnd() : reply;
}

/** A message that starts with quote lines, split into the passage and the rest; null when it starts with none. */
export function splitQuote(text) {
    const match = /^((?:>[^\n]*(?:\n|$))+)\n*([\s\S]*)$/.exec(text);

    if (!match) {
        return null;
    }

    const passage = match[1]
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n");

    return { passage, rest: match[2] };
}

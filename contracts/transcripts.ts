// Transcripts for the app: one keyed `PhoneTranscript` instance per opened conversation, a projection of
// pi-durable's ConversationView without inline image data and with long text clipped, plus paging and full-entry
// fetches. `PhoneTranscripts` opens and closes instances; `PhoneAgent` drives any conversation of the Session.
// Runtime-neutral; the app imports it. See DESIGN.md sections 5 and 6.
import { type Context, defineService, type JsonObject, type JsonValue, type ReplicatedState } from "@earendil-works/chord";

export type EntryId = number;
export type ConversationId = number;

/** Where an image block was, without its bytes. Bytes come from `PhoneTranscript.image()` or the HTTP image route. */
export interface ImageRef {
	type: "image";
	index: number;
	mimeType: string;
}

/** A text part whose `text` was cut; `clipped` is how many characters were removed. */
export interface ClippedText {
	type: "text";
	text: string;
	clipped: number;
}

export interface ProjectedEntry {
	id: EntryId;
	conversationId: ConversationId;
	kind: string;
	/** pi-ai messages with image parts replaced by ImageRef and long text parts by ClippedText. */
	model: JsonValue[] | null;
	data: JsonValue | null;
	head: EntryId | null;
}

export interface ProjectedView {
	conversationId: ConversationId;
	parent: { conversationId: ConversationId; at: EntryId } | null;
	entries: ProjectedEntry[];
	/** `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage`, as in ConversationView, images stripped. */
	docs: Record<string, JsonObject>;
}

export interface PhoneTranscript {
	readonly state: ReplicatedState<ProjectedView>;
	/** The full stored entry, images included. */
	entry(request: { entryId: EntryId }, context: Context): Promise<JsonObject>;
	/** Projected entries older than `before` (exclusive), newest first, through forks. */
	before(request: { before: EntryId; limit: number }, context: Context): Promise<{ entries: ProjectedEntry[]; more: boolean }>;
	image(request: { entryId: EntryId; index: number }, context: Context): Promise<{ mimeType: string; data: string }>;
}

export const PhoneTranscript = defineService<PhoneTranscript>("pi-phone.transcript");

export interface PhoneTranscriptsState {
	/** Conversation ids with a live `PhoneTranscript` instance. The instance key is `String(conversationId)`. */
	open: ConversationId[];
}

export interface PhoneTranscripts {
	readonly state: ReplicatedState<PhoneTranscriptsState>;
	open(request: { conversationId: ConversationId }, context: Context): Promise<void>;
	close(request: { conversationId: ConversationId }, context: Context): Promise<void>;
}

export const PhoneTranscripts = defineService<PhoneTranscripts>("pi-phone.transcripts");

export interface PhoneImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PhoneInput {
	conversationId: ConversationId;
	message: string;
	images: PhoneImage[] | null;
	/** Client-generated id; a retry with the same id finds the same submission. */
	requestId: string;
}

export type PhoneSubmitResult =
	| { accepted: true; submissionId: string; error: null }
	| { accepted: false; submissionId: null; error: { code: string; message: string } };

/** AgentController for any conversation of the Session. */
export interface PhoneAgent {
	prompt(input: PhoneInput, context: Context): Promise<PhoneSubmitResult>;
	steer(input: PhoneInput, context: Context): Promise<PhoneSubmitResult>;
	followUp(input: PhoneInput, context: Context): Promise<PhoneSubmitResult>;
	cancelQueued(request: { submissionId: string }, context: Context): Promise<{ outcome: "cancelled" | "not_found" | "already_consumed" }>;
	abort(request: { conversationId: ConversationId }, context: Context): Promise<void>;
	compact(request: { conversationId: ConversationId; instructions: string | null }, context: Context): Promise<PhoneSubmitResult>;
	reset(request: { conversationId: ConversationId; note: string | null }, context: Context): Promise<void>;
}

export const PhoneAgent = defineService<PhoneAgent>("pi-phone.agent");

// Transcript facets: `PhoneTranscripts` opens a keyed `PhoneTranscript` instance per conversation on demand (key =
// conversation id as a string), each mirroring the conversation's durable view through the projection; `PhoneAgent`
// submits to any conversation of the Session.
import { defineFacet, type Facet, type JsonObject, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AttachedReplicatedState,
	type Conversation,
	ConversationBusy,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type Harness,
	type SubmissionId,
	type UserInput,
} from "@earendil-works/pi-durable";
import {
	PhoneAgent,
	type PhoneInput,
	type PhoneSubmitResult,
	PhoneTranscript,
	PhoneTranscripts,
	type PhoneTranscriptsState,
} from "../../contracts/transcripts.ts";
import { imageOf, projectEntry, projectView } from "../projection.ts";

const context = BACKGROUND_CONTEXT;

async function conversationOf(harness: Harness, id: number): Promise<Conversation> {
	const conversation = await harness.conversation(id as ConversationId, context);
	if (conversation === undefined) throw new Error(`Unknown conversation: ${id}`);
	return conversation;
}

export function createTranscriptsFacet(harness: Harness): Facet {
	return defineFacet({
		id: "@pi-phone/transcripts",
		setup(env) {
			const spawner = env.provideMany(PhoneTranscript);
			const state = env.replicatedState<PhoneTranscriptsState>({ open: [] });
			const instances = new Map<number, { dispose(): void }>();

			const openInstance = async (id: number): Promise<void> => {
				if (instances.has(id)) return;
				const conversation = await conversationOf(harness, id);
				const view: AttachedReplicatedState<ConversationView> = await conversation.viewState(context);
				if (view.value === undefined) throw new Error(`Conversation ${id} has no view`);
				const mirror = replicatedState(projectView(view.value));
				const stop = view.subscribe((value) => {
					if (value !== undefined) mirror.replace(context, projectView(value));
				});
				const unspawn = spawner.spawn(String(id), {
					state: mirror,
					async entry({ entryId }) {
						const record = await harness.commit((tx) => tx.entry(entryId as EntryId), context);
						if (record === undefined) throw new Error(`Unknown entry: ${entryId}`);
						return record as unknown as JsonObject;
					},
					async before({ before, limit }) {
						if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1..200");
						const page = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, limit, undefined, context);
						return { entries: page.items.map(projectEntry), more: page.next !== undefined };
					},
					async image({ entryId, index }) {
						const record = await harness.commit((tx) => tx.entry(entryId as EntryId), context);
						if (record === undefined) throw new Error(`Unknown entry: ${entryId}`);
						const image = imageOf(record, index);
						if (image === undefined) throw new Error(`Entry ${entryId} has no image ${index}`);
						return image;
					},
				});
				instances.set(id, {
					dispose() {
						stop();
						unspawn();
						view.dispose();
					},
				});
				state.change(context, (draft) => {
					draft.open = [...instances.keys()].sort((a, b) => a - b);
				});
			};

			env.provide(PhoneTranscripts, {
				state,
				open: ({ conversationId }) => openInstance(conversationId),
				async close({ conversationId }) {
					const instance = instances.get(conversationId);
					if (instance === undefined) return;
					instances.delete(conversationId);
					instance.dispose();
					state.change(context, (draft) => {
						draft.open = [...instances.keys()].sort((a, b) => a - b);
					});
				},
			});

			env.onDeactivate(() => {
				for (const instance of instances.values()) instance.dispose();
				instances.clear();
			});
		},
	});
}

function toInput(input: PhoneInput): UserInput {
	if (input.images === null || input.images.length === 0) return input.message;
	return [{ type: "text", text: input.message }, ...input.images];
}

function toError(error: unknown): PhoneSubmitResult {
	if (error instanceof ConversationBusy) return { accepted: false, submissionId: null, error: { code: "busy", message: error.message } };
	return {
		accepted: false,
		submissionId: null,
		error: { code: "operation_failed", message: error instanceof Error ? error.message : String(error) },
	};
}

function parseSubmissionId(value: string): SubmissionId {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid submission id: ${value}`);
	return Number(value) as SubmissionId;
}

export function createAgentFacet(harness: Harness): Facet {
	const submit = async (whenBusy: "reject" | "steer" | "followUp", input: PhoneInput): Promise<PhoneSubmitResult> => {
		try {
			const conversation = await conversationOf(harness, input.conversationId);
			const submission = await conversation.submit(
				{ type: "input", content: toInput(input), whenBusy, requestId: input.requestId },
				context,
			);
			return { accepted: true, submissionId: String(submission.id), error: null };
		} catch (error) {
			return toError(error);
		}
	};
	return defineFacet({
		id: "@pi-phone/agent",
		setup(env) {
			env.provide(PhoneAgent, {
				prompt: (input) => submit("reject", input),
				steer: (input) => submit("steer", input),
				followUp: (input) => submit("followUp", input),
				async cancelQueued({ submissionId }) {
					const result = await harness.abortSubmission(parseSubmissionId(submissionId), context);
					return { outcome: result === "aborted" ? "cancelled" : result === "not_found" ? "not_found" : "already_consumed" };
				},
				async abort({ conversationId }) {
					await (await conversationOf(harness, conversationId)).abort(context);
				},
				async compact({ conversationId, instructions }) {
					try {
						const id = await (await conversationOf(harness, conversationId)).compact(instructions ?? undefined, context);
						return { accepted: true, submissionId: String(id), error: null };
					} catch (error) {
						return toError(error);
					}
				},
				async reset({ conversationId, note }) {
					await (await conversationOf(harness, conversationId)).reset(note ?? undefined, context);
				},
			});
		},
	});
}

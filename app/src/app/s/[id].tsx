// A Session's conversation: attach, open the projected transcript, render it, send / steer / queue / stop.
// Route params: id (session), c (conversation id, default root = 1).
import { randomUUID } from "expo-crypto";
import { Stack, useLocalSearchParams, useTheme } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Button, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import type { ProjectedView } from "../../../../contracts/transcripts.ts";
import { type Connection, connectionStore, context, type OpenTranscript } from "../../lib/connection.ts";
import { useStore } from "../../lib/store.ts";
import { liveOf, modelLabel, type Row, rowOf } from "../../model/view.ts";

export const ROOT_CONVERSATION = 1;

function useTranscript(connection: Connection | undefined, sessionId: string | undefined, conversationId: number) {
	const [view, setView] = useState<ProjectedView | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (connection === undefined || sessionId === undefined) return;
		let opened: OpenTranscript | undefined;
		let stop: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			try {
				await connection.attach(sessionId);
				opened = await connection.openTranscript(conversationId);
				if (cancelled) return;
				setView(opened.initial);
				stop = opened.transcript.state.subscribe((value) => {
					if (value !== undefined) setView(value);
				});
			} catch (reason: unknown) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		})();
		return () => {
			cancelled = true;
			stop?.();
			void opened?.close();
		};
	}, [connection, sessionId, conversationId]);
	return { view, error };
}

export default function SessionScreen() {
	const { id, c } = useLocalSearchParams<{ id: string; c?: string }>();
	const conversationId = c === undefined ? ROOT_CONVERSATION : Number(c);
	const connectionState = useStore(connectionStore);
	const connection = connectionState.status === "connected" ? connectionState.connection : undefined;
	const { view, error } = useTranscript(connection, id, conversationId);
	const [sendError, setSendError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const list = useRef<FlatList<Row>>(null);
	const { colors } = useTheme();
	const text = { color: colors.text };

	// Development auto-run (see index.tsx): send one prompt and log what the screen renders.
	const autoran = useRef(false);
	useEffect(() => {
		if (process.env.EXPO_PUBLIC_PI_AUTORUN !== "1" || view === undefined || autoran.current || connection === undefined) return;
		autoran.current = true;
		void connection.agent
			.prompt({ conversationId, message: "Reply with exactly: app ok", images: null, requestId: randomUUID() }, context)
			.then((result) => console.log(`autorun: prompt ${result.accepted ? "accepted" : result.error.message}`));
	}, [view, connection, conversationId]);
	useEffect(() => {
		if (process.env.EXPO_PUBLIC_PI_AUTORUN !== "1" || view === undefined) return;
		const live = liveOf(view);
		const last = view.entries.at(-1);
		console.log(
			`autorun: render entries=${view.entries.length} busy=${live.busy} last=${last === undefined ? "none" : `${last.kind}: ${rowOf(last).text.slice(0, 60)}`}`,
		);
	}, [view]);

	if (connection === undefined) return <Text style={[styles.notice, text]}>Not connected.</Text>;
	if (error !== null) return <Text style={[styles.notice, text]}>{error}</Text>;
	if (view === undefined) return <Text style={[styles.notice, text]}>Attaching…</Text>;

	const live = liveOf(view);
	const rows = view.entries.map(rowOf).filter((row) => row.kind !== "other");
	const send = async (mode: "prompt" | "steer" | "followUp"): Promise<void> => {
		const message = draft.trim();
		if (message === "") return;
		setDraft("");
		const input = { conversationId, message, images: null, requestId: randomUUID() };
		const result = await connection.agent[mode](input, context);
		if (!result.accepted) setSendError(result.error.message);
	};

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Stack.Screen options={{ title: `${id?.slice(0, 8) ?? ""} · ${modelLabel(view)}` }} />
			<FlatList
				ref={list}
				style={styles.list}
				data={rows}
				keyExtractor={(row) => String(row.id)}
				onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
				renderItem={({ item }) => (
					<View style={[styles.row, item.kind === "user" && styles.userRow]}>
						<Text style={[styles.rowTitle, text]}>{item.title}</Text>
						{item.text !== "" && (
							<Text style={[item.kind === "tool" ? styles.tool : styles.rowText, text]}>{item.text}</Text>
						)}
						{item.images.map((image) => (
							<Text key={image.index} style={[styles.tool, text]}>
								[image {image.index}: {image.mimeType}]
							</Text>
						))}
					</View>
				)}
				ListFooterComponent={
					live.busy ? (
						<View style={styles.row}>
							<Text style={[styles.rowTitle, text]}>
								{live.retry !== null ? `retrying: ${live.retry}` : live.tools.length > 0 ? "running tools" : "thinking"}
								{live.queued > 0 ? ` · ${live.queued} queued` : ""}
							</Text>
							{live.partial !== "" && <Text style={[styles.rowText, text]}>{live.partial}</Text>}
							{live.tools.map((tool) => (
								<Text key={tool.name + tool.status} style={[styles.tool, text]}>
									{tool.name}: {tool.status}
									{tool.output !== "" ? `\n${tool.output.slice(-400)}` : ""}
								</Text>
							))}
						</View>
					) : null
				}
			/>
			{sendError !== null && <Text style={[styles.notice, styles.error]}>{sendError}</Text>}
			<View style={[styles.composer, { borderTopColor: colors.border }]}>
				<TextInput
					style={[styles.input, text, { borderColor: colors.border }]}
					placeholderTextColor={colors.border}
					value={draft}
					onChangeText={setDraft}
					placeholder={live.busy ? "Steer the run…" : "Message"}
					multiline
				/>
				<View style={styles.buttons}>
					{live.busy ? (
						<>
							<Button title="Steer" onPress={() => void send("steer")} />
							<Button title="Queue" onPress={() => void send("followUp")} />
							<Button title="Stop" color="#c33" onPress={() => void connection.agent.abort({ conversationId }, context)} />
						</>
					) : (
						<Button title="Send" onPress={() => void send("prompt")} />
					)}
				</View>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1 },
	notice: { padding: 16 },
	error: { color: "#c33" },
	list: { flex: 1, paddingHorizontal: 12 },
	row: { paddingVertical: 8, gap: 4 },
	userRow: { backgroundColor: "#4a90d920", borderRadius: 8, paddingHorizontal: 8 },
	rowTitle: { fontWeight: "600", opacity: 0.7, fontSize: 12 },
	rowText: { fontSize: 15 },
	tool: { fontFamily: "monospace", fontSize: 12, opacity: 0.8 },
	composer: { padding: 8, gap: 8, borderTopWidth: 1 },
	input: { borderWidth: 1, borderRadius: 6, padding: 10, minHeight: 44, maxHeight: 140 },
	buttons: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
});

// A Session's root conversation: attach, render the Transcript replica, send / steer / queue / stop.
import type { ConversationView } from "@earendil-works/pi-durable";
import { Stack, useLocalSearchParams, useTheme } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Button, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { connectionStore, context } from "../../lib/connection.ts";
import { useStore } from "../../lib/store.ts";
import { liveOf, modelLabel, type Row, rowOf } from "../../model/view.ts";

export default function SessionScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const connectionState = useStore(connectionStore);
	const connection = connectionState.status === "connected" ? connectionState.connection : undefined;
	const [attached, setAttached] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [view, setView] = useState<ConversationView | undefined>(undefined);
	const [draft, setDraft] = useState("");
	const list = useRef<FlatList<Row>>(null);
	const { colors } = useTheme();
	const text = { color: colors.text };
	const border = { borderColor: colors.border };
	// Development auto-run (see index.tsx): send one prompt and log what the screen renders.
	const autoran = useRef(false);
	useEffect(() => {
		if (process.env.EXPO_PUBLIC_PI_AUTORUN !== "1" || !attached || autoran.current || connection === undefined) return;
		autoran.current = true;
		void connection.agent
			.prompt({ message: "Reply with exactly: app ok", images: null }, context)
			.then((result) => console.log(`autorun: prompt ${result.accepted ? "accepted" : result.error.message}`));
	}, [attached, connection]);
	useEffect(() => {
		if (process.env.EXPO_PUBLIC_PI_AUTORUN !== "1" || view === undefined) return;
		const live = liveOf(view);
		const last = view.entries.at(-1);
		console.log(`autorun: render entries=${view.entries.length} busy=${live.busy} partial="${live.partial.slice(0, 40)}" last=${last === undefined ? "none" : `${last.kind}: ${rowOf(last).text.slice(0, 60)}`}`);
	}, [view]);

	useEffect(() => {
		if (connection === undefined || id === undefined) return;
		let stop: (() => void) | undefined;
		let cancelled = false;
		void connection
			.attach(id)
			.then(() => {
				if (cancelled) return;
				setAttached(true);
				stop = connection.transcript.state.subscribe((value) => setView(value));
			})
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
		return () => {
			cancelled = true;
			stop?.();
		};
	}, [connection, id]);

	if (connection === undefined) return <Text style={[styles.notice, text]}>Not connected.</Text>;
	if (error !== null) return <Text style={[styles.notice, text]}>{error}</Text>;
	if (!attached || view === undefined) return <Text style={[styles.notice, text]}>Attaching…</Text>;

	const live = liveOf(view);
	const rows = view.entries.map(rowOf).filter((row) => row.kind !== "other");
	const send = async (mode: "prompt" | "steer" | "followUp"): Promise<void> => {
		const message = draft.trim();
		if (message === "") return;
		setDraft("");
		const request = { message, images: null };
		const result =
			mode === "prompt"
				? await connection.agent.prompt(request, context)
				: mode === "steer"
					? await connection.agent.steer(request, context)
					: await connection.agent.followUp(request, context);
		if (!result.accepted) setError(result.error.message);
	};

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Stack.Screen options={{ title: `${id.slice(0, 8)} · ${modelLabel(view)}` }} />
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
					</View>
				)}
				ListFooterComponent={
					live.busy ? (
						<View style={styles.row}>
							<Text style={[styles.rowTitle, text]}>
								{live.retry !== null ? `retrying: ${live.retry}` : live.tools.length > 0 ? "running tools" : "thinking"}
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
			<View style={[styles.composer, { borderTopColor: colors.border }]}>
				<TextInput
					style={[styles.input, text, border]}
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
							<Button title="Stop" color="#c33" onPress={() => void connection.agent.abort(context)} />
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
	list: { flex: 1, paddingHorizontal: 12 },
	row: { paddingVertical: 8, gap: 4 },
	userRow: { backgroundColor: "#4a90d920", borderRadius: 8, paddingHorizontal: 8 },
	rowTitle: { fontWeight: "600", opacity: 0.7, fontSize: 12 },
	rowText: { fontSize: 15 },
	tool: { fontFamily: "monospace", fontSize: 12, opacity: 0.8 },
	composer: { padding: 8, gap: 8, borderTopWidth: 1, borderTopColor: "#8884" },
	input: { borderWidth: 1, borderColor: "#888", borderRadius: 6, padding: 10, minHeight: 44, maxHeight: 140 },
	buttons: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
});

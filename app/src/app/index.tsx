// Session list and server settings. Step 4 scope: connect, list, create, open.
import { useRouter, useTheme } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Button, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { SessionSummary } from "pi-src/experimental/services/sessions.ts";
import { connectionStore, connectStored, context, DEFAULT_URL, loadSettings, saveSettings } from "../lib/connection.ts";
import { useStore } from "../lib/store.ts";

function useReplicated<T extends object>(state: { subscribe(listener: (value: T | undefined) => void): () => void }): T | undefined {
	const [value, setValue] = useState<T | undefined>(undefined);
	useEffect(() => state.subscribe(setValue), [state]);
	return value;
}

function ServerSettings() {
	const { colors } = useTheme();
	const field = { color: colors.text, borderColor: colors.border };
	const [url, setUrl] = useState(DEFAULT_URL);
	const [token, setToken] = useState("");
	const connection = useStore(connectionStore);
	useEffect(() => {
		void loadSettings().then((settings) => {
			setUrl(settings.url);
			setToken(settings.token);
		});
	}, []);
	const save = async (): Promise<void> => {
		await saveSettings({ url: url.trim(), token: token.trim() });
		await connectStored();
	};
	return (
		<View style={styles.settings}>
			<TextInput style={[styles.input, field]} placeholderTextColor={colors.border} value={url} onChangeText={setUrl} autoCapitalize="none" placeholder="ws://127.0.0.1:7741/pi" />
			<TextInput
				style={[styles.input, field]}
				placeholderTextColor={colors.border}
				value={token}
				onChangeText={setToken}
				autoCapitalize="none"
				placeholder="token from ~/.pi-phone/token"
				secureTextEntry
			/>
			<Button title={connection.status === "connecting" ? "Connecting…" : "Connect"} onPress={() => void save()} />
			{connection.status === "disconnected" && connection.error !== null && (
				<Text style={styles.error}>{connection.error}</Text>
			)}
		</View>
	);
}

function Sessions() {
	const router = useRouter();
	const connection = useStore(connectionStore);
	if (connection.status !== "connected") return null;
	const { directory, management } = connection.connection;
	return <SessionRows directory={directory} onCreate={async () => {
		const created = await management.create({}, context);
		router.push({ pathname: "/s/[id]", params: { id: created.sessionId } });
	}} onOpen={(id) => router.push({ pathname: "/s/[id]", params: { id } })} />;
}

function SessionRows(props: {
	directory: { state: { subscribe(listener: (value: { sessions: SessionSummary[] } | undefined) => void): () => void } };
	onCreate(): Promise<void>;
	onOpen(id: string): void;
}) {
	const { colors } = useTheme();
	const state = useReplicated<{ sessions: SessionSummary[] }>(props.directory.state);
	const sessions = [...(state?.sessions ?? [])].sort((a, b) => b.createdAt - a.createdAt);
	return (
		<View style={styles.sessions}>
			<Button title="New session" onPress={() => void props.onCreate()} />
			<FlatList
				data={sessions}
				keyExtractor={(item) => item.sessionId}
				renderItem={({ item }) => (
					<Pressable style={styles.row} onPress={() => props.onOpen(item.sessionId)}>
						<Text style={[styles.rowTitle, { color: colors.text }]}>{item.sessionId.slice(0, 8)}</Text>
						<Text style={[styles.rowMeta, { color: colors.text }]}>{new Date(item.createdAt).toLocaleString()}</Text>
					</Pressable>
				)}
			/>
		</View>
	);
}

export default function Index() {
	const router = useRouter();
	const connection = useStore(connectionStore);
	useEffect(() => {
		void connectStored();
	}, []);
	// Development auto-run: EXPO_PUBLIC_PI_AUTORUN=1 in app/.env creates a session and opens it once connected.
	const autoran = useRef(false);
	useEffect(() => {
		if (process.env.EXPO_PUBLIC_PI_AUTORUN !== "1" || connection.status !== "connected" || autoran.current) return;
		autoran.current = true;
		void connection.connection.management.create({}, context).then((created) => {
			console.log(`autorun: created ${created.sessionId}`);
			router.push({ pathname: "/s/[id]", params: { id: created.sessionId } });
		});
	}, [connection, router]);
	return (
		<View style={styles.screen}>
			<ServerSettings />
			<Sessions />
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, padding: 12, gap: 12 },
	settings: { gap: 8 },
	input: { borderWidth: 1, borderColor: "#888", borderRadius: 6, padding: 10, fontFamily: "monospace" },
	error: { color: "#c33" },
	sessions: { flex: 1, gap: 8 },
	row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#8884" },
	rowTitle: { fontFamily: "monospace", fontSize: 16 },
	rowMeta: { opacity: 0.6 },
});

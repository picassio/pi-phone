import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";

export default function RootLayout() {
	const scheme = useColorScheme();
	return (
		<ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
			<Stack>
				<Stack.Screen name="index" options={{ title: "pi" }} />
				<Stack.Screen name="s/[id]" options={{ title: "Session" }} />
			</Stack>
			<StatusBar style="auto" />
		</ThemeProvider>
	);
}

// Metro config: `pi-src/<module>` resolves to the pi checkout's `packages/coding-agent/src/<module>`, the same
// alias bin/resolver.mjs gives the server, so the app imports the experimental service contracts from source.
// PI_CHECKOUT defaults to ~/projects/pi.
const { getDefaultConfig } = require("expo/metro-config");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const checkout = path.resolve(process.env.PI_CHECKOUT ?? path.join(homedir(), "projects", "pi"));
const piSource = path.join(checkout, "packages", "coding-agent", "src");
if (!existsSync(piSource)) throw new Error(`pi checkout not found at ${checkout} (set PI_CHECKOUT)`);
const contracts = path.resolve(__dirname, "..", "contracts");
const client = path.resolve(__dirname, "..", "client");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), piSource, contracts, client];
// Files outside the app directory resolve their packages from the app's node_modules.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName.startsWith("pi-src/")) {
		const file = path.join(piSource, moduleName.slice("pi-src/".length));
		if (!existsSync(file)) throw new Error(`pi source module not found: ${file}`);
		return { type: "sourceFile", filePath: file };
	}
	return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;

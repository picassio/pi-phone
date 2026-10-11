// The Session worker's Harness: pi's model runtime, settings, coding tools, and system prompt, composed here so
// pi-phone can add its own pieces (billing patch, subagents, guard, facets) without changing pi.
import { combineFacetLoaders, createStaticFacetLoader } from "@earendil-works/chord";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "pi-src/core/model-runtime.ts";
import { SettingsManager } from "pi-src/core/settings-manager.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "pi-src/experimental/durable/harness-setup.ts";
import { createSessionPluginFacetLoader } from "pi-src/experimental/plugins/bundled.ts";
import type { CreateSessionWorkerHarness } from "pi-src/experimental/session-worker.ts";
import { createProvidersFacet } from "./facets/providers.ts";
import { createAgentFacet, createTranscriptsFacet } from "./facets/transcripts.ts";
import { withPhoneTransforms } from "./models.ts";
import { DATA_DIR_ENV, PhoneSettingsFile } from "./settings.ts";

export const createPhoneHarness: CreateSessionWorkerHarness = async (databasePath, options) => {
	const { cwd } = options.metadata;
	const dataDir = process.env[DATA_DIR_ENV];
	if (dataDir === undefined) throw new Error(`${DATA_DIR_ENV} is not set; workers must be spawned by server/main.ts`);
	const settings = new PhoneSettingsFile(dataDir);
	const plugins = createSessionPluginFacetLoader(options.pluginManifestPaths);
	const baseRuntime = await ModelRuntime.create();
	const modelRuntime = withPhoneTransforms(baseRuntime, settings);
	const settingsManager = SettingsManager.create(cwd);
	configureHarnessHttp(settingsManager);
	const envs = new ExecutionEnvs(cwd);
	let harness: Harness | undefined;
	try {
		harness = await Harness.open(
			await openNodeSqliteStorage(databasePath),
			{
				models: modelRuntime,
				registry: createCodingRegistry(settingsManager, cwd),
				settings: createHarnessSettings(settingsManager),
				env: envs.env,
				onReport: (error) => console.error(error),
			},
			TODO_CONTEXT,
		);
		// The initial model applies only when the root conversation is created; later starts keep its durable model.
		const created = (await harness.conversation(ROOT_CONVERSATION_ID, TODO_CONTEXT)) === undefined;
		const initial = created
			? await findInitialAgentModel(
					settingsManager,
					modelRuntime,
					options.model === undefined ? undefined : { provider: options.provider, model: options.model },
				)
			: undefined;
		const conversation = await harness.root(TODO_CONTEXT, {
			agent: {
				cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});
		return {
			harness,
			conversation,
			modelRuntime,
			settingsManager,
			facetLoader: combineFacetLoaders([
				createStaticFacetLoader([
					createProvidersFacet(baseRuntime, settingsManager),
					createTranscriptsFacet(harness),
					createAgentFacet(harness),
				]),
				...(plugins === undefined ? [] : [plugins]),
			]),
			cleanup: (context) => envs.cleanup(context),
		};
	} catch (error) {
		await harness?.close(TODO_CONTEXT);
		await envs.cleanup(TODO_CONTEXT);
		throw error;
	}
};

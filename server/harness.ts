// The Session worker's Harness: pi's model runtime, settings, coding tools, and system prompt, composed here so
// pi-phone can add its own pieces (billing patch, subagents, guard, facets) without changing pi.
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

export const createPhoneHarness: CreateSessionWorkerHarness = async (databasePath, options) => {
	const { cwd } = options.metadata;
	const modelRuntime = await ModelRuntime.create();
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
			facetLoader: createSessionPluginFacetLoader(options.pluginManifestPaths),
			cleanup: (context) => envs.cleanup(context),
		};
	} catch (error) {
		await harness?.close(TODO_CONTEXT);
		await envs.cleanup(TODO_CONTEXT);
		throw error;
	}
};

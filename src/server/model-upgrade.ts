/**
 * Google Antigravity models saved by their old ids (PP-555): before PR #17, a Gemini Enterprise account listed one model
 * per effort (`gemini-4-carbon-medium`); it now lists one per family (`gemini-4-carbon`) with the efforts as thinking
 * levels. A session, a subagent or a setting kept on an old id is moved to its family at the effort's level once its
 * account's catalog has the family, as the person would pick it now (`PocketApp.upgradeModels`).
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AGY_PROVIDER } from "./antigravity.ts";

/** agy's efforts at the end of an old id (`antigravity.ts`'s `EFFORT`). */
const EFFORT = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

/** What finds a model of a provider: the model runtime. */
export type ModelLookup = { getModel(provider: string, modelId: string): Model<Api> | undefined };

/** The family and level an old id stands for. */
export type Upgraded = { modelId: string; thinkingLevel: ModelThinkingLevel };

/**
 * The family model and thinking level for an Antigravity account's model saved by its old id: undefined when the id
 * is still listed, is no old id, is another provider's, or its account's catalog has no such family (not fetched yet,
 * or Google no longer offers it), so nothing is changed on a guess.
 */
export function upgradedModel(models: ModelLookup, provider: string, modelId: string): Upgraded | undefined {
    if ((provider !== AGY_PROVIDER && !provider.startsWith(`${AGY_PROVIDER}~`)) || models.getModel(provider, modelId) !== undefined) {
        return undefined;
    }

    const found = EFFORT.exec(modelId);
    const family = found === null ? undefined : models.getModel(provider, found[1]!);
    const level = family === undefined ? undefined : (Object.entries(family.thinkingLevelMap ?? {}).find(([, effort]) => effort === found![2])?.[0] as ModelThinkingLevel | undefined);

    return level === undefined ? undefined : { modelId: family!.id, thinkingLevel: level };
}

/** `provider/modelId` with its old id moved to its family (`upgradedModel`); the spec as it is otherwise. */
export function upgradedSpec(models: ModelLookup, spec: string): { spec: string; thinkingLevel?: ModelThinkingLevel } {
    const slash = spec.indexOf("/");
    const upgraded = slash <= 0 ? undefined : upgradedModel(models, spec.slice(0, slash), spec.slice(slash + 1));

    return upgraded === undefined ? { spec } : { spec: `${spec.slice(0, slash)}/${upgraded.modelId}`, thinkingLevel: upgraded.thinkingLevel };
}

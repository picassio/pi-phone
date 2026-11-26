// A Gemini Enterprise license's catalog and quota, in the shape agy 1.5.18 received them (captured 2026-11-26):
// `fetchAvailableModels {project, entitlement, location}` answers one model per effort and no `groupedModels`; its
// `agentModelSorts` lists what agy's CLI offers, while `models` (`recommended`, not `disabled`) and the quota also
// name agent models outside it (Gemini 4 Neon, Claude), which Antigravity's desktop app lists; the background models
// (Flash Lite, the image model) are not `recommended`. Only the models and the figures are kept; nothing of the account.
import type { AgyCatalog } from "../../src/server/antigravity.ts";

const effort = (family: string, name: string, model: string, levels: [string, number | undefined][], extra: Record<string, unknown> = {}) =>
    Object.fromEntries(
        levels.map(([suffix, level]) => [
            `${family}-${suffix}`,
            {
                displayName: `${name} (${suffix === "xhigh" ? "XHigh" : suffix[0]!.toUpperCase() + suffix.slice(1)})`,
                supportsImages: true,
                supportsThinking: true,
                recommended: true,
                ...(level === undefined ? {} : { thinkingLevel: level }),
                maxTokens: 1048576,
                maxOutputTokens: 65536,
                model,
                modelProvider: "MODEL_PROVIDER_GOOGLE",
                ...extra,
            },
        ]),
    );

/** The license's catalog. */
export const ENTERPRISE_FULL_CATALOG: AgyCatalog = {
    models: {
        ...effort("gemini-4-carbon", "Gemini 4 Carbon", "MODEL_PLACEHOLDER_M437", [["high", 3], ["low", 1], ["medium", 2]]),
        ...effort("gemini-4-hydrogen", "Gemini 4 Hydrogen", "MODEL_PLACEHOLDER_M525", [["high", 3], ["low", 1], ["medium", 2]]),
        ...effort("gemini-4-argon", "Gemini 4 Argon", "MODEL_PLACEHOLDER_M501", [["high", 3], ["low", 1], ["medium", 2]]),
        ...effort("gemini-4-neon", "Gemini 4 Neon", "MODEL_PLACEHOLDER_M540", [["high", 3], ["low", 1], ["medium", 2], ["xhigh", 7]]),
        ...effort("gemini-3.8-flash", "Gemini 3.8 Flash", "MODEL_PLACEHOLDER_M318", [["high", undefined], ["low", undefined], ["medium", undefined]]),
        ...effort("gemini-3.7-flash", "Gemini 3.7 Flash", "MODEL_PLACEHOLDER_M300", [["high", undefined], ["low", undefined], ["medium", undefined]]),
        ...effort("gemini-3.6-flash", "Gemini 3.6 Flash", "MODEL_PLACEHOLDER_M290", [["high", undefined], ["low", undefined], ["medium", undefined]]),
        ...effort("gemini-3.1-pro", "Gemini 3.1 Pro", "MODEL_PLACEHOLDER_M200", [["high", undefined], ["low", undefined]]),
        ...effort("claude-opus-5-5", "Claude Opus 5.5", "MODEL_PLACEHOLDER_M410", [["high", 3], ["low", 1], ["max", 200], ["medium", 2]], { modelProvider: "MODEL_PROVIDER_ANTHROPIC" }),
        "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", maxTokens: 1048576, maxOutputTokens: 65535, model: "MODEL_PLACEHOLDER_M277", modelProvider: "MODEL_PROVIDER_GOOGLE" },
        "gemini-3-pro-image": { displayName: "Gemini 3 Pro Image", maxTokens: 65536, maxOutputTokens: 32768, model: "MODEL_PLACEHOLDER_M21", modelProvider: "MODEL_PROVIDER_GOOGLE" },
    },
    agentModelSorts: [
        {
            groups: [
                {
                    modelIds: [
                        "gemini-4-carbon-medium",
                        "gemini-4-carbon-high",
                        "gemini-4-carbon-low",
                        "gemini-4-hydrogen-high",
                        "gemini-4-hydrogen-medium",
                        "gemini-4-hydrogen-low",
                        "gemini-4-argon-medium",
                        "gemini-4-argon-high",
                        "gemini-4-argon-low",
                        "gemini-3.8-flash-medium",
                        "gemini-3.8-flash-high",
                        "gemini-3.8-flash-low",
                        "gemini-3.7-flash-medium",
                        "gemini-3.7-flash-high",
                        "gemini-3.7-flash-low",
                        "gemini-3.6-flash-medium",
                        "gemini-3.6-flash-high",
                        "gemini-3.6-flash-low",
                        "gemini-3.1-pro-low",
                        "gemini-3.1-pro-high",
                    ],
                },
            ],
        },
    ],
    imageGenerationModelIds: ["gemini-3-pro-image"],
};

/** The license's quota: one bucket per model and effort, `remainingFraction` only, in Google's one group "All Models". */
export const ENTERPRISE_FULL_QUOTA = {
    groups: [
        {
            displayName: "All Models",
            buckets: [
                { bucketId: "gemini-4-carbon-medium", displayName: "Gemini 4 Carbon (Medium)", remainingFraction: 1 },
                { bucketId: "gemini-4-carbon-high", displayName: "Gemini 4 Carbon (High)", remainingFraction: 0.75 },
                { bucketId: "gemini-4-carbon-low", displayName: "Gemini 4 Carbon (Low)", remainingFraction: 1 },
                { bucketId: "gemini-4-neon-high", displayName: "Gemini 4 Neon (High)", remainingFraction: 1 },
                { bucketId: "gemini-4-neon-xhigh", displayName: "Gemini 4 Neon (XHigh)", remainingFraction: 1 },
                { bucketId: "gemini-4-hydrogen-high", displayName: "Gemini 4 Hydrogen (High)", remainingFraction: 0.5 },
                { bucketId: "gemini-4-hydrogen-medium", displayName: "Gemini 4 Hydrogen (Medium)", remainingFraction: 1 },
                { bucketId: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", remainingFraction: 1 },
                { bucketId: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 (High)", remainingFraction: 1 },
            ],
            description: "Gemini Pro, Gemini Flash, and Claude/GPT models have separate quota pools, each with a per-week and per-5-hour cap; this shows the one closest to being reached.",
        },
    ],
};

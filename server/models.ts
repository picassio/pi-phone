// pi's ModelRuntime with pi-phone's request transforms. pi-durable calls `streamSimple()` for generation and
// compaction; the wrapper adds pi-ai's `onPayload` so the Claude Code billing patch sees every provider payload.
// Methods are bound to the real runtime: ModelRuntime uses private fields, which a Proxy `this` would break.
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "pi-src/core/model-runtime.ts";
import { patchClaudeCodePayload } from "./cc-patch.ts";
import type { PhoneSettingsFile } from "./settings.ts";

type StreamSimple = ModelRuntime["streamSimple"];
type StreamSimpleOptions = NonNullable<Parameters<StreamSimple>[2]>;
type OnPayload = NonNullable<StreamSimpleOptions["onPayload"]>;

export function createPayloadTransform(settings: PhoneSettingsFile): OnPayload {
	return (payload, model: Model) => {
		const billing = settings.current().claudeCodeBilling;
		if (!billing.enabled) return undefined;
		return patchClaudeCodePayload(payload, model.provider, { version: billing.version });
	};
}

export function withPhoneTransforms(runtime: ModelRuntime, settings: PhoneSettingsFile): ModelRuntime {
	const transform = createPayloadTransform(settings);
	const streamSimple: StreamSimple = (model, context, options) => {
		const onPayload: OnPayload = async (payload, requestModel) => {
			const upstream = options?.onPayload === undefined ? undefined : await options.onPayload(payload, requestModel);
			return transform(upstream ?? payload, requestModel);
		};
		return runtime.streamSimple(model, context, { ...options, onPayload });
	};
	return new Proxy(runtime, {
		get(target, key) {
			if (key === "streamSimple") return streamSimple;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

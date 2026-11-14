/**
 * The Claude Code billing patch on every model request. Pi Durable, titles, and every other caller go through
 * `ModelRuntime.streamSimple` (`completeSimple` calls it too), so replacing it on the instance adds pi-ai's
 * `onPayload` to all of them. A caller's own `onPayload` runs first; the patch sees its result.
 *
 * A billed call sends its whole request (`disableContinuation`): since Pi 1.5.1 pi-ai continues an Anthropic
 * conversation as a message thread, whose continuation leaves out the system blocks, and with them the billing header
 * this patch puts there (pi-pocket e8d2b314).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { baseProvider } from "./accounts.ts";
import { patchClaudeCodePayload } from "./cc-patch.ts";
import type { PhoneSettingsFile } from "./phone-settings.ts";

type StreamSimple = ModelRuntime["streamSimple"];
type StreamSimpleOptions = NonNullable<Parameters<StreamSimple>[2]>;
type OnPayload = NonNullable<StreamSimpleOptions["onPayload"]>;

export function createBillingTransform(settings: PhoneSettingsFile): OnPayload {
    return (payload, model: Model<Api>) => {
        const billing = settings.current().claudeCodeBilling;

        if (!billing.enabled) {
            return undefined;
        }

        // An account of Anthropic (`anthropic~work`, accounts.ts) is Anthropic.
        return patchClaudeCodePayload(payload, baseProvider(model.provider), { version: billing.version });
    };
}

export function installClaudeCodeBilling(models: { streamSimple: StreamSimple }, settings: PhoneSettingsFile): void {
    const underlying = models.streamSimple.bind(models);
    const transform = createBillingTransform(settings);

    models.streamSimple = (model, context, options) => {
        const onPayload: OnPayload = async (payload, requestModel) => {
            const upstream =
                options?.onPayload === undefined ? undefined : await options.onPayload(payload, requestModel);

            return transform(upstream ?? payload, requestModel);
        };

        const billed = settings.current().claudeCodeBilling.enabled && baseProvider(model.provider) === "anthropic";

        return underlying(model, context, billed ? { ...options, onPayload, disableContinuation: true } : { ...options, onPayload });
    };
}

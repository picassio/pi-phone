// A stand-in for a subscription provider's account (accounts.ts) that a test signs in with a token of its own: the
// scripted provider, with an API key sign-in whose key is what `getAuth` gives (as a ChatGPT sign-in's token is).
import type { Provider } from "@earendil-works/pi-ai";

export function keyedProvider(base: Provider): Provider {
    return {
        ...base,
        auth: {
            apiKey: {
                name: "Test token",
                resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key }, source: "test" }),
            },
        },
    } as Provider;
}

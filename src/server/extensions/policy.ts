/**
 * A role's policy for Pi (PP-22, `policy.ts`): in a person's pi-phone behind the server edition's gateway, the tools their
 * role does not allow are refused before they run, and the prompt says what the role leaves out. Required (it cannot be
 * turned off, or turning it off would lift the policy). Without a policy (the phone), it does nothing.
 */
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { EXTENSIONS, TOOLS } from "../policy.ts";

export default function createPolicy(host: PocketHost) {
    return defineExtension({
        name: "pocket-policy",
        sections: [
            section("role-policy", () => {
                const policy = host.policy.get();

                if (policy === undefined) {
                    return "";
                }

                const missing = [...new Set([...Object.values(EXTENSIONS), ...Object.values(TOOLS), "terminal.use", "providers.signin"])].filter((permission) => !policy.permissions.includes(permission));
                const models = policy.models.length === 0 ? "" : ` Models you may use: ${policy.models.join(", ")}.`;
                const cap = policy.spendLimit === null ? "" : ` Spend is capped at $${policy.spendLimit} a month.`;

                return `This pi-phone is one person's on a team server; their role is ${policy.role}.${missing.length === 0 ? "" : ` It leaves out: ${missing.join(", ")} (tools for them are absent or refused; say so and suggest asking the team's owner).`}${models}${cap}`;
            }),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call) => {
                    const permission = TOOLS[call.name] ?? (call.name.startsWith("browser_") ? "browser.use" : undefined);
                    const refusal = permission === undefined ? undefined : host.policy.refusal(permission);

                    return refusal === undefined ? undefined : { block: refusal };
                },
            }),
        ],
    });
}

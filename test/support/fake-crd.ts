// A stand-in for a Windows machine's side of Chrome Remote Desktop (PP-263), as `fake-windows.ts` stands in for
// pi-phone's task: what pi-env's daemon would run there (`run`, `CrdRun`) answers `crd.ts`'s scripts (status, install,
// connect, remove) from a state the test sets, and keeps every call with the variables it was given, so a test sees
// where the owner's values went (and where they did not).
import type { CrdRun, CrdState } from "../../src/server/crd.ts";

export type FakeCrd = {
    state: CrdState;
    /** Every script run, its kind (`# pi-phone-crd <kind>`), and the variables set for it. */
    calls: { kind: string; script: string; env: Record<string, string> | undefined; machine: string }[];
    /** What install says instead of installing (a failure), once. */
    installSays?: { code: number; out: string };
    /** How remoting_start_host answers a connect: started, Google refusing the code, or a failure that repeats the values. */
    startHost: "started" | "expired" | "echo";
    /** The values a connect was given (from its variables). */
    given: { code?: string; redirect?: string; pin?: string };
    run: CrdRun;
};

export const NOT_INSTALLED: CrdState = { installed: false, version: null, productCode: null, service: null, config: false };
export const CONNECTED: CrdState = { installed: true, version: "154.0.8037.40", productCode: "{9CCBB3AA-219D-4A90-841E-DD59AE8A46C6}", service: "Running", config: true };

export function fakeCrd(state: CrdState = NOT_INSTALLED): FakeCrd {
    const fake: FakeCrd = {
        state: { ...state },
        calls: [],
        startHost: "started",
        given: {},
        run: async (machine, script, _timeout, env) => {
            const kind = /^# pi-phone-crd (\w+)/.exec(script)?.[1] ?? "other";
            const line = () => `crd ${JSON.stringify(fake.state)}\n`;

            fake.calls.push({ kind, script, env: env === undefined ? undefined : { ...env }, machine: machine.id });

            switch (kind) {
                case "status":
                    return { code: 0, out: line() };

                case "install": {
                    const says = fake.installSays;

                    if (says !== undefined) {
                        fake.installSays = undefined;

                        return says;
                    }

                    if (fake.state.installed) {
                        return { code: 0, out: `already\n${line()}` };
                    }

                    fake.state = { installed: true, version: "154.0.8037.40", productCode: "{9CCBB3AA-219D-4A90-841E-DD59AE8A46C6}", service: "Stopped", config: false };

                    return { code: 0, out: `msiexec 0\n${line()}` };
                }

                case "connect": {
                    fake.given = { code: env?.PI_CRD_CODE, redirect: env?.PI_CRD_REDIRECT, pin: env?.PI_CRD_PIN };

                    if (!fake.state.installed) {
                        return { code: 41, out: "fail not-installed\n" };
                    }

                    if (fake.startHost === "expired") {
                        return { code: 0, out: `start-host 1\nEnter a PIN of at least six digits: \nCouldn't start host: OAuth error.\n${line()}` };
                    }

                    if (fake.startHost === "echo") {
                        return { code: 0, out: `start-host 1\nCouldn't start host: Registration error. ${fake.given.code} ${fake.given.redirect} ${fake.given.pin}\n${line()}` };
                    }

                    fake.state = { ...fake.state, service: "Running", config: true };

                    return { code: 0, out: `start-host 0\nEnter a PIN of at least six digits: \nEnter the same PIN again: \nHost started successfully.\n${line()}` };
                }

                case "remove":
                    if (!fake.state.installed) {
                        return { code: 0, out: `already-gone\n${line()}` };
                    }

                    fake.state = { ...NOT_INSTALLED };

                    return { code: 0, out: `msiexec 0\n${line()}` };

                default:
                    return { code: 127, out: "" };
            }
        },
    };

    return fake;
}

// A stand-in for a Windows machine with pi-phone's task (PP-179), as `fake-ocu.ts` stands in for ocu: what pi-env's
// daemon runs there (`run`) answers the scripts of `computer-windows.ts` (status, connect, install, remove) from a state
// the test sets, files written there are kept (`files`), and a bridge here speaks the bridge's protocol (a JSON first
// line with the token, then ocu's MCP or the sign) with the stand-in ocu behind it. `forward` stands for the app's ssh
// forward: the port is the same here. Nothing goes through ssh's own shell (`launch`) on Windows.
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { ComputerControlOptions } from "../../src/server/computer-control.ts";

const FAKE = join(import.meta.dirname, "fake-ocu.ts");

export type FakeWindows = {
    /** How the machine stands; the test changes it. */
    state: { task: boolean; loggedOn: boolean; locked: boolean; running: boolean };
    /** The token the connect script says, and the bridge's own (a wrong one: they differ). */
    token: string;
    bridgeToken: string;
    /** How Chrome Remote Desktop stands there (PP-263), as the status script says it with the task's state. */
    crd: "not installed" | "installed, not connected" | "connected";
    /** Every script run on the machine, and the files written there (by path under its home). */
    scripts: { kind: string; script: string }[];
    files: Map<string, string>;
    /** Every first line the bridge got (without its token), and the forwards opened and closed. */
    hellos: Record<string, unknown>[];
    forwards: { opened: number[]; closed: number };
    /** Connections open at the bridge now. */
    open: () => number;
    launch: ComputerControlOptions["launch"];
    run: NonNullable<ComputerControlOptions["run"]>;
    writeFile: NonNullable<ComputerControlOptions["writeFile"]>;
    forward: NonNullable<ComputerControlOptions["forward"]>;
    port: () => number;
    close: () => Promise<void>;
};

export async function fakeWindows(options: { ocuLog: string; sign?: string }): Promise<FakeWindows> {
    const sockets = new Set<Socket>();
    const fake: Omit<FakeWindows, "launch" | "run" | "writeFile" | "forward" | "port" | "close"> = {
        state: { task: true, loggedOn: true, locked: false, running: false },
        token: "a".repeat(64),
        bridgeToken: "a".repeat(64),
        crd: "not installed",
        scripts: [],
        files: new Map(),
        hellos: [],
        forwards: { opened: [], closed: 0 },
        open: () => sockets.size,
    };
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let buffer = Buffer.alloc(0);
        const first = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf(10);

            if (end === -1) {
                return;
            }

            socket.off("data", first);
            const hello = JSON.parse(buffer.subarray(0, end).toString()) as Record<string, unknown>;
            const rest = buffer.subarray(end + 1);
            const { token, ...seen } = hello;

            fake.hellos.push(seen);

            if (token !== fake.bridgeToken) {
                socket.end("no wrong token\n");

                return;
            }

            const child = spawn(process.execPath, [FAKE, hello.run === "sign" ? "sign" : "mcp"], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, FAKE_OCU_LOG: options.ocuLog, ...(options.sign === undefined ? {} : { FAKE_SIGN: options.sign }) },
            });

            socket.write("ok\n");
            child.stdout.pipe(socket);

            if (rest.length > 0) {
                child.stdin.write(rest);
            }

            socket.pipe(child.stdin);
            child.once("exit", () => socket.end());
            socket.once("close", () => child.kill());
        };

        socket.on("data", first);
        socket.on("error", () => {});
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = () => (server.address() as { port: number }).port;
    const stateLine = () => `state ${JSON.stringify({ ...fake.state, crd: fake.crd })}\n`;

    return {
        ...fake,
        get state() {
            return fake.state;
        },
        set state(value) {
            fake.state = value;
        },
        get token() {
            return fake.token;
        },
        set token(value) {
            fake.token = value;
        },
        get bridgeToken() {
            return fake.bridgeToken;
        },
        set bridgeToken(value) {
            fake.bridgeToken = value;
        },
        get crd() {
            return fake.crd;
        },
        set crd(value) {
            fake.crd = value;
        },
        port,
        launch: () => {
            throw new Error("Windows runs nothing through ssh's own shell");
        },
        writeFile: async (_machine, path, text) => {
            fake.files.set(path, text);
        },
        run: async (_machine, script) => {
            const kind = /^# pi-phone-computer (\w+)/.exec(script)?.[1] ?? "other";

            fake.scripts.push({ kind, script });

            switch (kind) {
                case "status":
                    return { out: stateLine(), code: 0 };

                case "connect":
                    if (!fake.state.task) {
                        return { out: "", code: 20 };
                    }

                    if (!fake.state.loggedOn) {
                        return { out: "", code: 21 };
                    }

                    fake.state.running = true;

                    return { out: `bridge ${port()} ${fake.token}\n`, code: 0 };

                case "install":
                    if (!fake.files.has(".pi/mobile/computer/bridge.ps1")) {
                        return { out: "pi-phone's bridge.ps1 is not in ~/.pi/mobile/computer: nothing was registered.\n", code: 8 };
                    }

                    fake.state = { ...fake.state, task: true, running: fake.state.loggedOn };

                    return { out: stateLine(), code: 0 };

                case "remove":
                    fake.state = { ...fake.state, task: false, running: false };

                    return { out: stateLine(), code: 0 };

                default:
                    return { out: "", code: 127 };
            }
        },
        forward: async (_machine, remote) => {
            fake.forwards.opened.push(remote);

            return {
                port: remote,
                close: () => {
                    fake.forwards.closed += 1;
                },
            };
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }

            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

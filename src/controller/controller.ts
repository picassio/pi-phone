/**
 * The server edition's controller (PP-21): the only part that talks to Docker. The gateway asks it, over a Unix socket
 * only the two share, to make, start, stop, or remove one person's pi-phone, and nothing else. Each person gets a
 * network of their own (only the gateway is attached to it besides their container), a volume, and a container from the
 * one pi-phone image, with fixed options: not privileged, no capabilities, no new privileges, no host mounts beyond the
 * person's volume, no published ports, and the memory and CPU caps asked for (within limits). A request outside this
 * shape is refused, whatever the gateway sends.
 */
import { randomBytes } from "node:crypto";
import { type IncomingMessage, request as httpRequest } from "node:http";

/** A person's id as the gateway names them: lowercase letters and digits only, so it is safe in every Docker name. */
export const PERSON_ID = /^[a-z0-9]{6,40}$/;
/** Caps a container may be given: at least, and at most. */
export const MEMORY_MB = { min: 256, max: 16_384 } as const;
export const CPUS = { min: 0.25, max: 8 } as const;

export type Caps = { memoryMb: number; cpus: number };

export type ControllerOptions = {
    /** Docker's API socket (`/var/run/docker.sock`). */
    docker: string;
    /** The pi-phone image every person runs (`pi-phone-server:local`). */
    image: string;
    /** The gateway's container: attached to each person's network so it alone reaches them. */
    gateway: string;
    /** The time zone people's containers run in. */
    timezone?: string;
};

export type Person = { container: string; host: string; port: number; running: boolean };

/** A person's container in the list: whose, whether it runs, and whether it is of the image people run now. */
export type Listed = { id: string; host: string; port: number; running: boolean; current: boolean };

/** What a refused or failed request says: its HTTP status, and why. */
export class ControllerError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const names = (id: string) => ({ container: `pp-user-${id}`, network: `pp-net-${id}`, volume: `pp-data-${id}` });

export class Controller {
    readonly #options: ControllerOptions;

    constructor(options: ControllerOptions) {
        this.#options = options;
    }

    /** One call to Docker's API: its status and its body (JSON when it sent JSON). */
    async #docker(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
        return new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
            const sent = httpRequest(
                {
                    socketPath: this.#options.docker,
                    method,
                    path: `/v1.44${path}`,
                    headers: { host: "docker", ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": payload.length }) },
                },
                (response) => {
                    const chunks: Buffer[] = [];

                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let parsed: unknown = text;

                        try {
                            parsed = text === "" ? undefined : JSON.parse(text);
                        } catch {
                            // Not JSON: kept as text.
                        }

                        resolve({ status: response.statusCode ?? 0, body: parsed });
                    });
                },
            );

            sent.on("error", reject);
            sent.end(payload);
        });
    }

    /** A GET whose answer is streamed as it comes (an archive), not read whole. */
    async #stream(path: string): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const sent = httpRequest({ socketPath: this.#options.docker, method: "GET", path: `/v1.44${path}`, headers: { host: "docker" } }, resolve);

            sent.on("error", reject);
            sent.end();
        });
    }

    async #expect(method: string, path: string, body: unknown, ok: number[]): Promise<unknown> {
        const answer = await this.#docker(method, path, body);

        if (!ok.includes(answer.status)) {
            const message = (answer.body as { message?: string } | undefined)?.message ?? String(answer.body);

            throw new ControllerError(502, `Docker ${method} ${path.split("?")[0]}: ${answer.status} ${message}`);
        }

        return answer.body;
    }

    static check(id: string): void {
        if (!PERSON_ID.test(id)) {
            throw new ControllerError(400, "A person's id is 6 to 40 lowercase letters and digits.");
        }
    }

    static caps(caps: unknown): Caps {
        const given = caps as Partial<Caps> | undefined;
        const memoryMb = Number(given?.memoryMb);
        const cpus = Number(given?.cpus);

        if (!Number.isInteger(memoryMb) || memoryMb < MEMORY_MB.min || memoryMb > MEMORY_MB.max) {
            throw new ControllerError(400, `memoryMb is a whole number from ${MEMORY_MB.min} to ${MEMORY_MB.max}.`);
        }

        if (!Number.isFinite(cpus) || cpus < CPUS.min || cpus > CPUS.max) {
            throw new ControllerError(400, `cpus is a number from ${CPUS.min} to ${CPUS.max}.`);
        }

        return { memoryMb, cpus };
    }

    /** The id of the image people run now, or undefined when there is none yet. */
    async #imageId(): Promise<string | undefined> {
        const answer = await this.#docker("GET", `/images/${encodeURIComponent(this.#options.image)}/json`);

        return answer.status === 200 ? (answer.body as { Id?: string }).Id : undefined;
    }

    /** Every person's container (labelled `io.piphone.role=person`), running or not. */
    async list(): Promise<Listed[]> {
        const filters = encodeURIComponent(JSON.stringify({ label: ["io.piphone.role=person"] }));
        const found = (await this.#expect("GET", `/containers/json?all=true&filters=${filters}`, undefined, [200])) as { Labels?: Record<string, string>; State?: string; ImageID?: string }[];
        const image = await this.#imageId();

        return found
            .map((each) => {
                const id = each.Labels?.["io.piphone.person"] ?? "";

                return { id, host: names(id).container, port: 8787, running: each.State === "running", current: image !== undefined && each.ImageID === image };
            })
            .filter((each) => PERSON_ID.test(each.id));
    }

    /** A person's container now: running or not, or undefined when there is none. */
    async status(id: string): Promise<Person | undefined> {
        Controller.check(id);
        const { container } = names(id);
        const answer = await this.#docker("GET", `/containers/${container}/json`);

        if (answer.status === 404) {
            return undefined;
        }

        if (answer.status !== 200) {
            throw new ControllerError(502, `Docker inspect: ${answer.status}`);
        }

        return { container, host: container, port: 8787, running: (answer.body as { State?: { Running?: boolean } }).State?.Running === true };
    }

    /**
     * Make (first time) and start a person's pi-phone, with the owner token the gateway made for them and the caps of
     * their role. A container that exists keeps its volume; one whose caps changed has them updated. One of an older
     * image (PP-34) is made again from the image people run now, keeping its volume: when it is stopped, or, with
     * `renew`, running too (stopped first, as `stop` does).
     */
    async ensure(id: string, token: string, caps: Caps, renew = false): Promise<Person> {
        Controller.check(id);
        Controller.caps(caps);

        if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
            throw new ControllerError(400, "The owner token is 24 to 128 letters, digits, - or _.");
        }

        const { container, network, volume } = names(id);
        const labels = { "io.piphone.role": "person", "io.piphone.person": id };

        // The person's network: their container and the gateway on it, nobody else.
        if ((await this.#docker("GET", `/networks/${network}`)).status === 404) {
            await this.#expect("POST", "/networks/create", { Name: network, Driver: "bridge", Labels: labels }, [201]);
        }

        const attached = (await this.#expect("GET", `/networks/${network}`, undefined, [200])) as { Containers?: Record<string, { Name?: string }> };

        if (!Object.values(attached.Containers ?? {}).some((each) => each.Name === this.#options.gateway)) {
            await this.#expect("POST", `/networks/${network}/connect`, { Container: this.#options.gateway }, [200]);
        }

        if ((await this.#docker("GET", `/volumes/${volume}`)).status === 404) {
            await this.#expect("POST", "/volumes/create", { Name: volume, Labels: labels }, [201]);
        }

        const hostConfig = {
            Memory: caps.memoryMb * 1024 * 1024,
            MemorySwap: caps.memoryMb * 1024 * 1024,
            NanoCpus: Math.round(caps.cpus * 1e9),
            PidsLimit: 2048,
            Mounts: [{ Type: "volume", Source: volume, Target: "/data" }],
            NetworkMode: network,
            RestartPolicy: { Name: "unless-stopped" },
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
            Privileged: false,
            PortBindings: {},
        };
        const existing = await this.#docker("GET", `/containers/${container}/json`);
        let make = existing.status === 404;

        if (existing.status === 200) {
            const found = existing.body as { Image?: string; State?: { Running?: boolean } };
            const image = await this.#imageId();
            const running = found.State?.Running === true;

            if (image !== undefined && found.Image !== image && (renew || !running)) {
                if (running) {
                    await this.#expect("POST", `/containers/${container}/stop?t=20`, undefined, [204, 304]);
                }

                await this.#expect("DELETE", `/containers/${container}?force=true`, undefined, [204, 404]);
                make = true;
            }
        }

        if (make) {
            await this.#expect(
                "POST",
                `/containers/create?name=${container}`,
                {
                    Image: this.#options.image,
                    Hostname: container,
                    Env: [`PI_PHONE_OWNER_TOKEN=${token}`, "PI_PHONE_GATEWAY=1", `TZ=${this.#options.timezone ?? "UTC"}`],
                    Labels: labels,
                    HostConfig: hostConfig,
                },
                [201],
            );
        } else {
            await this.#expect("POST", `/containers/${container}/update`, { Memory: hostConfig.Memory, MemorySwap: hostConfig.MemorySwap, NanoCpus: hostConfig.NanoCpus }, [200]);
        }

        await this.#expect("POST", `/containers/${container}/start`, undefined, [204, 304]);

        return { container, host: container, port: 8787, running: true };
    }

    /**
     * A person's data (their volume's /data) as a tar stream (PP-35), from a helper container that is made with the volume
     * read-only, never started, on no network, and removed once the stream ends. Stopped people and removed accounts
     * (whose volume stays) have theirs too. A running pi-phone's is taken as it is at that moment.
     */
    async export(id: string): Promise<IncomingMessage> {
        Controller.check(id);
        const { volume } = names(id);

        if ((await this.#docker("GET", `/volumes/${volume}`)).status === 404) {
            throw new ControllerError(404, "This person has no data yet.");
        }

        const helper = `pp-export-${id}-${randomBytes(4).toString("hex")}`;
        const removeHelper = () => this.#docker("DELETE", `/containers/${helper}?force=true`).catch(() => undefined);

        await this.#expect(
            "POST",
            `/containers/create?name=${helper}`,
            {
                Image: this.#options.image,
                Labels: { "io.piphone.role": "export", "io.piphone.person": id },
                HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: "/data", ReadOnly: true }], NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
            },
            [201],
        );

        try {
            const archive = await this.#stream(`/containers/${helper}/archive?path=${encodeURIComponent("/data")}`);

            if (archive.statusCode !== 200) {
                archive.resume();
                throw new ControllerError(502, `Docker archive: ${archive.statusCode}`);
            }

            archive.once("close", () => void removeHelper());

            return archive;
        } catch (error) {
            await removeHelper();
            throw error;
        }
    }

    async stop(id: string): Promise<void> {
        Controller.check(id);
        await this.#expect("POST", `/containers/${names(id).container}/stop?t=20`, undefined, [204, 304, 404]);
    }

    /** Remove a person's container and network; their volume (their data) stays unless `purge`. */
    async remove(id: string, purge: boolean): Promise<void> {
        Controller.check(id);
        const { container, network, volume } = names(id);

        await this.#expect("DELETE", `/containers/${container}?force=true`, undefined, [204, 404]);
        // Docker keeps a network with anyone still on it: the gateway leaves it first, when it is on it. (A gateway made
        // again is not, until its next ensure; Docker answers a disconnect from a network it is not on with a 500.)
        const found = await this.#docker("GET", `/networks/${network}`);

        if (found.status === 200) {
            const on = Object.values((found.body as { Containers?: Record<string, { Name?: string }> }).Containers ?? {}).some((each) => each.Name === this.#options.gateway);

            if (on) {
                await this.#expect("POST", `/networks/${network}/disconnect`, { Container: this.#options.gateway, Force: true }, [200]);
            }

            await this.#expect("DELETE", `/networks/${network}`, undefined, [204, 404]);
        }

        if (purge) {
            await this.#expect("DELETE", `/volumes/${volume}`, undefined, [204, 404]);
        }
    }
}

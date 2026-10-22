// Where a session works (src/server/places.ts): a folder on this phone, or one on a machine, carried as one string,
// `machine:<machine id>:<path>`. These split it, and name a machine from the list `hello` sends.
import { store } from "./store.js";

const PREFIX = "machine:";

/** `{ machineId, path }` for a place on a machine; `{ path }` for one on the phone. */
export function splitPlace(cwd) {
    if (typeof cwd !== "string" || !cwd.startsWith(PREFIX)) {
        return { machineId: undefined, path: cwd };
    }

    const rest = cwd.slice(PREFIX.length);
    const colon = rest.indexOf(":");

    return colon <= 0 ? { machineId: undefined, path: cwd } : { machineId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

export const joinPlace = (machineId, path) => (machineId === undefined ? path : `${PREFIX}${machineId}:${path}`);

export const isRemotePlace = (cwd) => typeof cwd === "string" && cwd.startsWith(PREFIX);

/**
 * Whether a failure to open a folder says it is not there yet, so the picker offers to make it: a whole path here (`~`,
 * `/`), or any folder on a machine (`machine:<id>:C:/…` too), whose server says "There is no folder …" (PP-103).
 */
export const missingFolder = (error, target) =>
    error.status === 404 && /isn't there|There is no folder/.test(error.message) && (/^\s*[~/]/.test(target) || isRemotePlace(target));

/** The machines `hello` listed (connected ones only), by id. */
export const machineById = (id) => (store.state.server?.machines ?? []).find((each) => each.id === id);

/** A machine's name for a place on one; undefined on the phone. A machine since removed keeps a short id. */
export function machineNameOf(cwd) {
    const { machineId } = splitPlace(cwd);

    if (machineId === undefined) {
        return undefined;
    }

    return machineById(machineId)?.name ?? `machine ${machineId.slice(0, 8)}`;
}

/** A place's home: the machine's for one on a machine, `home` otherwise. */
export function homeOf(cwd, home) {
    const { machineId } = splitPlace(cwd);

    return machineId === undefined ? home : machineById(machineId)?.home;
}

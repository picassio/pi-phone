// The gateway's board and document services for tests (PP-39, PP-46), on a folder of their own.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { BoardService } from "../src/gateway/boards.ts";
import { DocService } from "../src/gateway/docs.ts";
import type { GatewayStore } from "../src/gateway/store.ts";
import { TeamAccounts } from "../src/gateway/team-accounts.ts";
import { TeamMachines } from "../src/gateway/team-machines.ts";
import { root } from "./helpers.ts";

/** The services a test gateway needs; its team accounts are made, and opened only by tests that use them. */
export function served(store: GatewayStore): { boards: BoardService; docs: DocService; teamAccounts: TeamAccounts; teamMachines: TeamMachines } {
    const dir = mkdtempSync(join(root, "gw-boards-"));
    const boards = new BoardService(store, dir);

    return { boards, docs: new DocService(store, boards, dir), teamAccounts: new TeamAccounts(store, dir), teamMachines: new TeamMachines(store, dir) };
}

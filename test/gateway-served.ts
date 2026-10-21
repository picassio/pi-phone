// The gateway's board and document services for tests (PP-39, PP-46), on a folder of their own.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { BoardService } from "../src/gateway/boards.ts";
import { DocService } from "../src/gateway/docs.ts";
import type { GatewayStore } from "../src/gateway/store.ts";
import { root } from "./helpers.ts";

export function served(store: GatewayStore): { boards: BoardService; docs: DocService } {
    const dir = mkdtempSync(join(root, "gw-boards-"));
    const boards = new BoardService(store, dir);

    return { boards, docs: new DocService(store, boards, dir) };
}

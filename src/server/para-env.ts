/**
 * Before pi-para and qmd-engine load: their SQLite goes through Node's own node:sqlite (`QMD_SQLITE_DRIVER=node`,
 * qmd-engine 2.7, pi-para 0.8), as better-sqlite3 has no Android build. Both read it once, when their modules load, so
 * `para.ts` imports this first. pi-phone runs no other driver: this sets it, whatever the environment said.
 */
process.env.QMD_SQLITE_DRIVER = "node";

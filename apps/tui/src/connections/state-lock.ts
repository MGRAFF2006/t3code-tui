// @effect-diagnostics nodeBuiltinImport:off -- Private state uses a crash-releasing local transaction lock.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";

export async function acquirePrivateStateLock(
  filename: string,
  busyMessage = "TUI state is busy in another terminal. Retry after its operation finishes.",
  options: { wait?: boolean } = {},
) {
  const handle = await NodeFSP.open(filename, "a", 0o600);
  await handle.close();
  const Database = process.versions.bun
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync;
  const attempts = options.wait === false ? 1 : 200;
  // Never unlink this file: the OS releases the transaction lock when its owner exits.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const database = new Database(filename);
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      return database;
    } catch (error) {
      database.close();
      if (
        !(error instanceof Error) ||
        !(
          ("errcode" in error && error.errcode === 5) ||
          ("code" in error && error.code === "SQLITE_BUSY")
        )
      )
        throw error;
    }
    if (attempt + 1 < attempts) await Effect.runPromise(Effect.sleep("25 millis"));
  }
  throw new Error(busyMessage);
}

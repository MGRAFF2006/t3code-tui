// @effect-diagnostics nodeBuiltinImport:off -- Verifies private state locks against an independent owned process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { acquirePrivateStateLock } from "./state-lock.ts";

it("keeps a cross-process reservation after a second local store fails to acquire it", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-lock-overlap-"));
  const filename = NodePath.join(directory, "state.lock.sqlite");
  const lock = await acquirePrivateStateLock(filename, "busy", { wait: false });
  try {
    await expect(acquirePrivateStateLock(filename, "busy", { wait: false })).rejects.toThrow(
      "busy",
    );
    const probe = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      try { db.exec("BEGIN EXCLUSIVE"); process.stdout.write("acquired"); }
      catch (error) { if (error.code !== "SQLITE_BUSY" && error.errcode !== 5) throw error; process.stdout.write("busy"); }
      finally { db.close(); }
    `,
        filename,
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("busy");
    expect((await NodeFSP.stat(filename)).mode & 0o777).toBe(0o600);
  } finally {
    lock.close();
    await NodeFSP.rm(directory, { recursive: true });
  }
});

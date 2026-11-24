// @effect-diagnostics nodeBuiltinImport:off -- Local terminal preferences share the existing private client state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TimestampFormat, ToolCallVisibility } from "@t3tools/contracts/settings";
import {
  preparePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "../connections/files.ts";

const ThreadLayout = Schema.Struct({
  workspaceOpen: Schema.Boolean,
  tab: Schema.Literals(["changes", "files", "git", "browser", "terminals", "devices", "details"]),
  maximized: Schema.Boolean,
  openPath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  openLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type TuiThreadLayout = typeof ThreadLayout.Type;
export const threadLayoutKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

const Preferences = Schema.Struct({
  sidebarGrouping: Schema.Literals(["flat", "project"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("flat")),
  ),
  threadDetailsItems: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  threadLayouts: Schema.Record(Schema.String, ThreadLayout)
    .check(Schema.makeFilter((value) => Object.keys(value).length <= 500))
    .pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarWidth: Schema.Int.check(Schema.isBetween({ minimum: 22, maximum: 1000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(29)),
  ),
  workspaceWidth: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 42, maximum: 1000 })),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(Effect.succeed("locale"))),
  icons: Schema.Literals(["auto", "nerd", "plain"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("auto")),
  ),
  theme: Schema.Literals(["system", "light", "dark"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("system")),
  ),
  sendShortcut: Schema.Literals(["enter", "ctrl-s"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  toolCallVisibility: ToolCallVisibility.pipe(
    Schema.withDecodingDefault(Effect.succeed("showAll")),
  ),
  diffView: Schema.Literals(["unified", "split"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("unified")),
  ),
  followUpMode: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("queue")),
  ),
});
export type TuiPreferences = typeof Preferences.Type;
export type TuiPreferencesPatch = Partial<TuiPreferences>;
const decodePreferences = Schema.decodeSync(Preferences);
const Document = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), settings: Preferences }),
);
const decodeDocument = Schema.decodeSync(Document);
const encodeDocument = Schema.encodeSync(Document);
export const DEFAULT_TUI_PREFERENCES: TuiPreferences = decodePreferences({});

export async function createPreferences(configDir: string) {
  const filename = NodePath.join(configDir, "preferences.json");
  await preparePrivateDirectory(configDir);
  async function read() {
    try {
      const contents = await readPrivateFile(filename);
      return contents === null ? DEFAULT_TUI_PREFERENCES : decodeDocument(contents).settings;
    } catch (error) {
      throw new Error(
        `Could not read terminal preferences at ${filename}. The file was left unchanged.`,
        { cause: error },
      );
    }
  }
  let preferences = await read();
  const listeners = new Set<(value: TuiPreferences) => void>();
  let pending: Promise<unknown> = Promise.resolve();
  function change(transform: (current: TuiPreferences) => TuiPreferences): Promise<TuiPreferences> {
    const save = pending.then(async () => {
      const lockPath = `${filename}.lock`;
      let lock;
      try {
        lock = await NodeFSP.open(lockPath, "wx", 0o600);
      } catch (error) {
        throw new Error(
          `Could not lock terminal preferences at ${filename}. Retry after other TUI writes finish.`,
          { cause: error },
        );
      }
      try {
        const latest = await read();
        const next = decodePreferences(transform(latest));
        await writePrivateFile(filename, encodeDocument({ version: 1, settings: next }));
        preferences = next;
        for (const listener of listeners) listener(next);
        return next;
      } finally {
        await lock.close();
        await NodeFSP.rm(lockPath, { force: true });
      }
    });
    pending = save.catch(() => undefined);
    return save;
  }
  return {
    get: () => preferences,
    update: (patch: TuiPreferencesPatch) => {
      if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_TUI_PREFERENCES, key)))
        return Promise.reject(new Error("Unknown terminal preference."));
      return change((latest) => ({ ...latest, ...patch }));
    },
    updateThreadLayout: (key: string, layout: TuiThreadLayout) =>
      change((latest) => ({
        ...latest,
        threadLayouts: Object.fromEntries(
          [
            ...Object.entries(latest.threadLayouts).filter(([scope]) => scope !== key),
            [key, layout],
          ].slice(-500),
        ),
      })),
    subscribe: (listener: (value: TuiPreferences) => void) => {
      listeners.add(listener);
      listener(preferences);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

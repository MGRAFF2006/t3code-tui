// @effect-diagnostics nodeBuiltinImport:off -- Unconfirmed messages live in the terminal's private local state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { acquirePrivateStateLock } from "../connections/state-lock.ts";
import * as Schema from "effect/Schema";
import {
  ChatAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { DraftSchema } from "../conversation/draft-storage.ts";
import {
  preparePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "../connections/files.ts";

const SendInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    context: Schema.optionalKey(OrchestrationMessageContext),
    idleCompaction: Schema.optionalKey(Schema.Literal("onReturn")),
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  dispatchMode: Schema.optionalKey(Schema.Literals(["auto", "queue", "steer", "restart", "start"])),
  freshContext: Schema.optionalKey(Schema.Boolean),
});
const PendingSend = Schema.Struct({
  id: CommandId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  createdAt: Schema.String,
  steps: Schema.Array(SendInput).check(Schema.isMinLength(1)),
  nextStep: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attempted: Schema.optionalKey(Schema.Boolean),
  composerDraft: Schema.optionalKey(DraftSchema),
});
export type PendingSend = typeof PendingSend.Type;
export type PendingSendInput = typeof SendInput.Type;
const Document = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), send: PendingSend }),
);
const decode = Schema.decodeSync(Document);
const encode = Schema.encodeSync(Document);

export interface InvalidPendingSend {
  readonly file: string;
  readonly error: string;
  readonly environmentId?: string;
  readonly threadId?: string;
}

export async function createSendOutbox(configDir: string) {
  const directory = NodePath.join(configDir, "pending-sends");
  await preparePrivateDirectory(directory);
  const path = (id: string) => NodePath.join(directory, `${encodeURIComponent(id)}.json`);
  const listeners = new Set<(entries: readonly PendingSend[]) => void>();
  const active = new Set<string>();
  let entries: readonly PendingSend[] = [];
  let invalid: readonly InvalidPendingSend[] = [];
  async function read(id: string): Promise<PendingSend>;
  async function read(id: string, allowMissing: true): Promise<PendingSend | null>;
  async function read(id: string, allowMissing = false) {
    const contents = await readPrivateFile(path(id));
    if (contents === null && allowMissing) return null;
    if (contents === null)
      throw new Error("This pending send has already been resolved or discarded.");
    let entry: PendingSend;
    try {
      entry = decode(contents).send;
    } catch {
      throw new Error(
        `The pending-send record at ${path(id)} cannot be decoded. It was left unchanged.`,
      );
    }
    if (
      entry.id !== id ||
      entry.nextStep > entry.steps.length ||
      entry.steps.at(-1)?.commandId !== entry.id ||
      new Set(entry.steps.map((step) => step.commandId)).size !== entry.steps.length ||
      new Set(entry.steps.map((step) => step.message.messageId)).size !== entry.steps.length ||
      entry.steps.some((step) => step.threadId !== entry.threadId)
    )
      throw new Error("The pending-send record is invalid. It was left unchanged.");
    return entry;
  }
  async function refresh() {
    const files = await NodeFSP.readdir(directory);
    const bad: InvalidPendingSend[] = [];
    const next = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const filename = NodePath.join(directory, file);
          try {
            const id = decodeURIComponent(file.slice(0, -5));
            if (path(id) !== filename)
              throw new Error("The pending-send filename is not canonical. It was left unchanged.");
            return await read(id, true);
          } catch (error) {
            let scope: { environmentId?: string; threadId?: string } = {};
            try {
              const raw = JSON.parse((await readPrivateFile(filename)) ?? "null");
              if (
                typeof raw?.send?.environmentId === "string" &&
                typeof raw?.send?.threadId === "string"
              )
                scope = { environmentId: raw.send.environmentId, threadId: raw.send.threadId };
            } catch {
              /* The invalid bytes remain available for explicit inspection. */
            }
            bad.push({
              file: filename,
              error: error instanceof Error ? error.message : String(error),
              ...scope,
            });
            return null;
          }
        }),
    );
    const snapshot = {
      entries: next
        .filter((entry) => entry !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      invalid: bad.sort((a, b) => a.file.localeCompare(b.file)),
    };
    entries = snapshot.entries;
    invalid = snapshot.invalid;
    for (const listener of listeners) listener(entries);
    return snapshot;
  }
  async function save(entry: PendingSend) {
    await writePrivateFile(path(entry.id), encode({ version: 1, send: entry }));
    await refresh();
  }
  const scopeKey = (environmentId: string, threadId: string) =>
    JSON.stringify([environmentId, threadId]);
  async function withScope<A>(environmentId: string, threadId: string, use: () => Promise<A>) {
    const scope = scopeKey(environmentId, threadId);
    if (active.has(scope))
      throw new Error(
        "Wait for this pending-send operation to finish; it is already being checked.",
      );
    active.add(scope);
    try {
      const digest = NodeCrypto.createHash("sha256").update(scope).digest("hex");
      const lock = await acquirePrivateStateLock(
        NodePath.join(directory, `${digest}.lock.sqlite`),
        "A message is already being prepared or checked for this conversation in another terminal.",
        { wait: false },
      );
      try {
        return await use();
      } finally {
        lock.close();
      }
    } finally {
      active.delete(scope);
    }
  }
  const remove = async (id: string) => {
    await NodeFSP.rm(path(id), { force: true });
    await refresh();
  };
  async function add(entry: PendingSend) {
    const current = await refresh();
    if (current.entries.some((existing) => existing.id === entry.id))
      throw new Error("This send is already pending.");
    if (
      current.entries.some(
        (existing) =>
          existing.environmentId === entry.environmentId && existing.threadId === entry.threadId,
      )
    )
      throw new Error(
        "This conversation has an unconfirmed send. Open Pending sends to check or retry the original message.",
      );
    if (
      current.invalid.some(
        (existing) =>
          existing.file === path(entry.id) ||
          (existing.environmentId === entry.environmentId && existing.threadId === entry.threadId),
      )
    )
      throw new Error(
        "This conversation has an unreadable pending send. Open Pending sends to inspect its recovery file.",
      );
    await save(entry);
  }
  async function dispatch(
    id: string,
    execute: (
      entry: PendingSend,
      input: PendingSendInput,
      markAttempted: () => Promise<void>,
    ) => Promise<void>,
    settle: (entry: PendingSend) => Promise<void> = async () => {},
  ) {
    let entry = await read(id);
    for (let index = entry.nextStep; index < entry.steps.length; index += 1) {
      await execute(entry, entry.steps[index]!, async () => {
        entry = Object.assign({}, entry, { attempted: true });
        await save(entry);
      });
      entry = Object.assign({}, entry, { nextStep: index + 1 });
      await save(entry);
    }
    await settle(entry);
    await remove(id);
    return entry;
  }
  async function operate<A>(id: string, use: (entry: PendingSend) => Promise<A>) {
    const initial = await read(id);
    return withScope(initial.environmentId, initial.threadId, async () => use(await read(id)));
  }
  await refresh();
  return {
    get: () => entries,
    invalid: () => invalid,
    refresh: async () => (await refresh()).entries,
    read,
    reserve: <A>(
      environmentId: string,
      threadId: string,
      prepare: (operations: { add: typeof add; dispatch: typeof dispatch }) => Promise<A>,
    ) =>
      withScope(environmentId, threadId, async () => {
        const current = await refresh();
        if (
          current.entries.some(
            (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
          )
        )
          throw new Error(
            "This conversation has an unconfirmed send. Open Pending sends to check or retry the original message.",
          );
        if (
          current.invalid.some(
            (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
          )
        )
          throw new Error(
            "This conversation has an unreadable pending send. Open Pending sends to inspect its recovery file.",
          );
        return prepare({ add, dispatch });
      }),
    add: (entry: PendingSend) => withScope(entry.environmentId, entry.threadId, () => add(entry)),
    discard: (id: string) => operate(id, () => remove(id)),
    dispatch: (
      id: string,
      execute: Parameters<typeof dispatch>[1],
      settle: Parameters<typeof dispatch>[2] = async () => {},
    ) => operate(id, () => dispatch(id, execute, settle)),
    retry: (
      id: string,
      accepted: (entry: PendingSend) => Promise<boolean>,
      prepare: (entry: PendingSend) => Promise<PendingSend>,
      prepared: (entry: PendingSend) => void,
      execute: Parameters<typeof dispatch>[1],
      settle: Parameters<typeof dispatch>[2],
    ) =>
      operate(id, async (entry) => {
        if (entry.nextStep < entry.steps.length) {
          if (await accepted(entry)) await save({ ...entry, nextStep: entry.steps.length });
          else {
            const next = await prepare(entry);
            await save(next);
            prepared(next);
          }
        }
        await dispatch(id, execute, settle);
        return entry;
      }),
    reconcile: (
      id: string,
      accepted: (entry: PendingSend) => Promise<boolean>,
      settle: Parameters<typeof dispatch>[2],
    ) =>
      operate(id, async (entry) => {
        if (entry.nextStep < entry.steps.length && !(await accepted(entry))) return false;
        const completed = { ...entry, nextStep: entry.steps.length };
        await save(completed);
        if (settle) await settle(completed);
        await remove(id);
        return entry;
      }),
    inspectInvalid: async (file: string) => {
      const current = await refresh();
      if (!current.invalid.some((entry) => entry.file === file))
        throw new Error("This unreadable record is no longer present.");
      return (await readPrivateFile(file)) ?? "The record no longer exists.";
    },
    moveAside: async (file: string) => {
      const current = await refresh();
      const original = current.invalid.find((entry) => entry.file === file);
      if (!original) throw new Error("This unreadable record is no longer present.");
      return withScope(
        original.environmentId ?? "invalid-file",
        original.threadId ?? file,
        async () => {
          const checked = await refresh();
          if (!checked.invalid.some((entry) => entry.file === file))
            throw new Error("This record changed. Inspect it again before moving it aside.");
          // link refuses to overwrite an earlier recovery copy.
          await NodeFSP.link(file, `${file}.invalid`);
          await NodeFSP.unlink(file);
          await refresh();
        },
      );
    },
    subscribe: (listener: (value: readonly PendingSend[]) => void) => {
      listeners.add(listener);
      listener(entries);
      return () => listeners.delete(listener);
    },
  };
}

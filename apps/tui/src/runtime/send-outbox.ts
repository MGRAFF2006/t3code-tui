// @effect-diagnostics nodeBuiltinImport:off -- Unconfirmed messages live in the terminal's private local state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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
  composerDraft: Schema.optionalKey(DraftSchema),
});
export type PendingSend = typeof PendingSend.Type;
export type PendingSendInput = typeof SendInput.Type;
const Document = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), send: PendingSend }),
);
const decode = Schema.decodeSync(Document);
const encode = Schema.encodeSync(Document);

export async function createSendOutbox(configDir: string) {
  const directory = NodePath.join(configDir, "pending-sends");
  await preparePrivateDirectory(directory);
  const path = (id: string) => NodePath.join(directory, `${encodeURIComponent(id)}.json`);
  const listeners = new Set<(entries: readonly PendingSend[]) => void>();
  const active = new Set<string>();
  let entries: readonly PendingSend[] = [];
  async function read(id: string): Promise<PendingSend>;
  async function read(id: string, allowMissing: true): Promise<PendingSend | null>;
  async function read(id: string, allowMissing = false) {
    const contents = await readPrivateFile(path(id));
    if (contents === null && allowMissing) return null;
    if (contents === null)
      throw new Error("This pending send has already been resolved or discarded.");
    const entry = decode(contents).send;
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
    const next = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => read(decodeURIComponent(file.slice(0, -5)), true)),
    );
    entries = next
      .filter((entry) => entry !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const listener of listeners) listener(entries);
    return entries;
  }
  async function save(entry: PendingSend) {
    await writePrivateFile(path(entry.id), encode({ version: 1, send: entry }));
    await refresh();
  }
  async function discard(id: string) {
    if (active.has(id)) throw new Error("Wait for this pending-send operation to finish.");
    await NodeFSP.rm(path(id), { force: true });
    await refresh();
  }
  await refresh();
  return {
    get: () => entries,
    refresh,
    read,
    add: async (entry: PendingSend) => {
      if (entries.some((existing) => existing.id === entry.id))
        throw new Error("This send is already pending.");
      await save(entry);
    },
    discard,
    dispatch: async (
      id: string,
      execute: (entry: PendingSend, input: PendingSendInput) => Promise<void>,
    ) => {
      if (active.has(id)) throw new Error("This pending send is already being checked.");
      active.add(id);
      try {
        const entry = await read(id);
        for (let index = entry.nextStep; index < entry.steps.length; index += 1) {
          await execute({ ...entry, nextStep: index }, entry.steps[index]!);
          await save({ ...entry, nextStep: index + 1 });
        }
        await NodeFSP.rm(path(id), { force: true });
        await refresh();
      } finally {
        active.delete(id);
      }
    },
    subscribe: (listener: (value: readonly PendingSend[]) => void) => {
      listeners.add(listener);
      listener(entries);
      return () => listeners.delete(listener);
    },
  };
}

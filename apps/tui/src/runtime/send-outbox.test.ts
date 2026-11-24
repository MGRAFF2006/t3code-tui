// @effect-diagnostics nodeBuiltinImport:off -- Exercises durable pending sends in owned temporary private state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createSendOutbox, type PendingSend, type PendingSendInput } from "./send-outbox.ts";

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-outbox-"))),
    use,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  );
const input = (id: string, text: string): PendingSendInput => ({
  commandId: CommandId.make(id),
  threadId: ThreadId.make("thread"),
  message: { messageId: MessageId.make(`message-${id}`), role: "user", text, attachments: [] },
  modelSelection: { instanceId: ProviderInstanceId.make("provider"), model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  dispatchMode: "queue",
});
const entry = (): PendingSend => ({
  id: CommandId.make("send"),
  environmentId: EnvironmentId.make("destination"),
  threadId: ThreadId.make("thread"),
  createdAt: "2026-11-24T12:00:00.000Z",
  steps: [input("compact", "/compact"), input("send", "message with private context")],
  composerDraft: {
    text: "raw @mention",
    mentions: [],
    context: [],
    attachments: [],
    freshContext: false,
  },
  nextStep: 0,
});

describe("terminal uncertain-send outbox", () => {
  it.effect(
    "persists before dispatch, recovers the exact uncertain command and does not repeat confirmed compaction",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => createSendOutbox(directory));
          const original = entry();
          yield* Effect.promise(() => first.add(original));
          const attempts: PendingSendInput[] = [];
          yield* Effect.promise(() =>
            expect(
              first.dispatch(original.id, async (saved, command) => {
                const disk = await createSendOutbox(directory);
                expect(disk.get()[0]).toEqual(saved);
                attempts.push(command);
                if (command.commandId === original.id)
                  throw new Error("Connection closed before receipt");
              }),
            ).rejects.toThrow("Connection closed before receipt"),
          );
          const reopened = yield* Effect.promise(() => createSendOutbox(directory));
          expect(reopened.get()).toEqual([{ ...original, nextStep: 1 }]);
          yield* Effect.promise(() =>
            expect(
              reopened.dispatch(
                original.id,
                async (saved, command) => {
                  expect(saved.environmentId).toBe("destination");
                  attempts.push(command);
                },
                async () => {
                  throw new Error("Draft disk unavailable");
                },
              ),
            ).rejects.toThrow("Draft disk unavailable"),
          );
          const accepted = yield* Effect.promise(() => createSendOutbox(directory));
          expect(accepted.get()[0]?.nextStep).toBe(original.steps.length);
          yield* Effect.promise(() =>
            accepted.dispatch(
              original.id,
              async () => {
                throw new Error("Accepted message must not dispatch again");
              },
              async () => {},
            ),
          );
          expect(attempts).toEqual([original.steps[0], original.steps[1], original.steps[1]]);
          expect((yield* Effect.promise(() => createSendOutbox(directory))).get()).toEqual([]);
          expect(
            (yield* Effect.promise(() => NodeFSP.stat(NodePath.join(directory, "pending-sends"))))
              .mode & 0o777,
          ).toBe(0o700);
        }),
      ),
  );

  it.effect(
    "keeps a failed first command recoverable and prevents local discard or second retry while dispatching",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const outbox = yield* Effect.promise(() => createSendOutbox(directory));
          const original = entry();
          yield* Effect.promise(() => outbox.add(original));
          const otherWindow = yield* Effect.promise(() => createSendOutbox(directory));
          yield* Effect.promise(() =>
            expect(
              outbox.dispatch(original.id, async () => {
                await expect(outbox.discard(original.id)).rejects.toThrow(
                  "Wait for this pending-send operation",
                );
                await expect(outbox.dispatch(original.id, async () => {})).rejects.toThrow(
                  "already being checked",
                );
                await expect(otherWindow.discard(original.id)).rejects.toThrow("another terminal");
                await expect(otherWindow.dispatch(original.id, async () => {})).rejects.toThrow(
                  "another terminal",
                );
                await expect(
                  otherWindow.reconcile(
                    original.id,
                    async () => true,
                    async () => {},
                  ),
                ).rejects.toThrow("another terminal");
                throw new Error("Access revoked");
              }),
            ).rejects.toThrow("Access revoked"),
          );
          expect(outbox.get()).toEqual([original]);
          const file = NodePath.join(directory, "pending-sends", "send.json");
          expect((yield* Effect.promise(() => NodeFSP.stat(file))).mode & 0o777).toBe(0o600);
          yield* Effect.promise(() => outbox.discard(original.id));
          expect((yield* Effect.promise(() => createSendOutbox(directory))).get()).toEqual([]);
        }),
      ),
  );

  it.effect(
    "reserves the conversation before asynchronous preparation without blocking another conversation",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => createSendOutbox(directory));
          const second = yield* Effect.promise(() => createSendOutbox(directory));
          const started = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let prepared = 0;
          let dispatched = 0;
          const sending = first.reserve("destination", "thread", async (reserved) => {
            prepared++;
            started.resolve();
            await release.promise;
            await reserved.add(entry());
            await reserved.dispatch(
              "send",
              async () => {
                dispatched++;
              },
              async () => {},
            );
          });
          yield* Effect.promise(() => started.promise);
          yield* Effect.promise(() =>
            expect(
              second.reserve("destination", "thread", async () => {
                prepared++;
              }),
            ).rejects.toThrow("another terminal"),
          );
          yield* Effect.promise(() =>
            second.reserve("destination", "unrelated-thread", async () => {}),
          );
          release.resolve();
          yield* Effect.promise(() => sending);
          expect(prepared).toBe(1);
          expect(dispatched).toBe(2);
          expect(yield* Effect.promise(second.refresh)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "preserves other windows' pending sends and refuses to overwrite unreadable recovery data",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => createSendOutbox(directory));
          const second = yield* Effect.promise(() => createSendOutbox(directory));
          const original = entry();
          const other = {
            ...entry(),
            id: CommandId.make("other"),
            environmentId: EnvironmentId.make("other-environment"),
            steps: [input("other", "other private message")],
          };
          yield* Effect.promise(() => first.add(original));
          yield* Effect.promise(() => second.add(other));
          expect((yield* Effect.promise(() => first.refresh())).map((value) => value.id)).toEqual([
            "other",
            "send",
          ]);
          yield* Effect.promise(() => first.discard(original.id));
          expect((yield* Effect.promise(() => second.refresh())).map((value) => value.id)).toEqual([
            "other",
          ]);
          const filename = NodePath.join(directory, "pending-sends", "other.json");
          yield* Effect.promise(() => NodeFSP.writeFile(filename, "invalid pending-send record"));
          const damaged = yield* Effect.promise(() => createSendOutbox(directory));
          expect(damaged.invalid()).toEqual([expect.objectContaining({ file: filename })]);
          expect(damaged.get()).toEqual([]);
          yield* Effect.promise(() => damaged.moveAside(filename));
          expect(damaged.invalid()).toEqual([]);
          expect(yield* Effect.promise(() => NodeFSP.readFile(`${filename}.invalid`, "utf8"))).toBe(
            "invalid pending-send record",
          );
        }),
      ),
  );
});

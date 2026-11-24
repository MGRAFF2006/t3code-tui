// @effect-diagnostics nodeBuiltinImport:off -- Owns private temporary draft storage for deletion lifecycle coverage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { draftStore, createDraftStore } from "./draft-storage.ts";
import {
  clearConversationDraft,
  createDraftOwnership,
  drafts,
  draftOwners,
} from "./draft-ownership.ts";
import type { Draft } from "./draft.ts";

it.effect.each(["reply-first", "event-first"] as const)(
  "deletion cannot resurrect a side-chat draft with %s delivery",
  (order) =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-delete-draft-"))),
      (directory) =>
        Effect.gen(function* () {
          const scope = `${directory}/thread`;
          const persistence = draftStore(directory, () => {});
          yield* Effect.promise(() => persistence.ready);
          const value: Draft = {
            text: "Deleted child prompt",
            mentions: [],
            context: [],
            attachments: [],
            freshContext: false,
          };
          const ownership = createDraftOwnership(scope, persistence, value);
          const owner = { invalidate: ownership.invalidate, apply: () => {}, settled: () => {} };
          draftOwners.set(scope, owner);
          ownership.update(value);
          yield* Effect.promise(persistence.flush);
          if (order === "event-first") {
            ownership.update(value);
            draftOwners.delete(scope);
          }
          yield* Effect.promise(() =>
            clearConversationDraft({ localStateDirectory: directory }, scope),
          );
          if (order === "reply-first") ownership.update(value);
          yield* Effect.promise(persistence.flush);
          const reopened = createDraftStore(directory, () => {});
          yield* Effect.promise(() => reopened.ready);
          expect(reopened.get(scope)).toBeUndefined();
          expect(drafts.has(scope)).toBe(false);
          draftOwners.delete(scope);
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
);

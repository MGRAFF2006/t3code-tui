// @effect-diagnostics nodeBuiltinImport:off -- Exercises generated attachments only in an owned temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { readLocalAttachment } from "../runtime/attachments.ts";
import { planComposerTextPaste, stagePastedTextAttachment } from "./pasted-text.ts";

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-paste-"))),
    use,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  );

describe("native pasted-text attachments", () => {
  it("folds UTF-8-sized pastes and over-limit insertions, accounting for replacement, capacity and an explicit inline override", () => {
    const base = {
      value: "",
      selection: { start: 0, end: 0 },
      maxFileBytes: 1_000_000,
      attachmentCount: 0,
      existingNames: [],
    };
    expect(planComposerTextPaste({ ...base, text: "x".repeat(32 * 1024 - 1) }).kind).toBe("inline");
    expect(
      planComposerTextPaste({
        ...base,
        text: "😀".repeat(8 * 1024),
        existingNames: ["PASTED-TEXT.TXT"],
      }),
    ).toMatchObject({ kind: "attachment", name: "pasted-text-2.txt", sizeBytes: 32 * 1024 });
    const full = {
      ...base,
      value: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
      selection: { start: 5, end: 7 },
    };
    expect(planComposerTextPaste({ ...full, text: "ab" }).kind).toBe("inline");
    expect(planComposerTextPaste({ ...full, text: "abc" }).kind).toBe("attachment");
    expect(planComposerTextPaste({ ...full, text: "abc", maxFileBytes: null }).kind).toBe(
      "blocked",
    );
    expect(
      planComposerTextPaste({
        ...full,
        text: "abc",
        attachmentCount: 99,
        reservedAttachmentCount: 1,
      }).kind,
    ).toBe("blocked");
    expect(
      planComposerTextPaste({ ...base, text: "x".repeat(32 * 1024), attachmentCount: 100 }).kind,
    ).toBe("inline");
    expect(planComposerTextPaste({ ...full, text: "abc", maxFileBytes: 2 }).kind).toBe("blocked");
    expect(
      planComposerTextPaste({ ...full, text: "x".repeat(32 * 1024), bypassAutoAttachment: true })
        .kind,
    ).toBe("inline");
  });

  it.effect(
    "keeps retained private files readable across reuse and discards only uncommitted staging files",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const text = "Pasted context\nGrüße 😀";
          const first = yield* Effect.promise(() =>
            stagePastedTextAttachment(directory, text, {
              name: "pasted-text.txt",
              maxFileBytes: 1024,
            }),
          );
          expect(
            new TextDecoder().decode(
              yield* Effect.promise(() => readLocalAttachment(first.attachment)),
            ),
          ).toBe(text);
          expect(first.attachment).toMatchObject({
            name: "pasted-text.txt",
            type: "file",
            mimeType: "text/plain",
          });
          expect(
            (yield* Effect.promise(() => NodeFSP.stat(first.attachment.path))).mode & 0o777,
          ).toBe(0o600);
          expect(
            (yield* Effect.promise(() => NodeFSP.stat(NodePath.dirname(first.attachment.path))))
              .mode & 0o777,
          ).toBe(0o700);
          yield* Effect.promise(first.discard);
          yield* Effect.promise(async () => {
            await expect(NodeFSP.stat(first.attachment.path)).rejects.toThrow();
          });
          const retained = yield* Effect.promise(() =>
            stagePastedTextAttachment(directory, text, {
              name: "pasted-text-2.txt",
              maxFileBytes: 1024,
            }),
          );
          retained.retain();
          yield* Effect.promise(retained.discard);
          expect(
            new TextDecoder().decode(
              yield* Effect.promise(() => readLocalAttachment(retained.attachment)),
            ),
          ).toBe(text);
          yield* Effect.promise(async () => {
            await expect(
              stagePastedTextAttachment(directory, text, {
                name: "pasted-text.txt",
                maxFileBytes: 1,
              }),
            ).rejects.toThrow("limit");
            await expect(
              stagePastedTextAttachment(directory, text, {
                name: "../outside.txt",
                maxFileBytes: 1024,
              }),
            ).rejects.toThrow("name");
          });
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(directory, "pasted-text")),
            )).filter((name) => name.endsWith(".txt")),
          ).toHaveLength(1);
        }),
      ),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- Exercises attachment staging only in an owned temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ChatAttachmentId, type ChatAttachment } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { stageRewindAttachments } from "./rewind-attachments.ts";

const source: ChatAttachment = {
  id: ChatAttachmentId.make("attachment"),
  name: "original.txt",
  type: "file",
  mimeType: "text/plain",
  sizeBytes: 5,
};

it("restores private attachment bytes for durable drafts and discards unretained or partially restored files", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tui-rewind-"));
  try {
    const staged = await stageRewindAttachments({
      directory,
      attachments: [source],
      maxFileBytes: 1024,
      read: async () => new TextEncoder().encode("hello"),
    });
    const attachment = staged.attachments[0]!;
    expect(attachment).toMatchObject({
      name: "original.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(await NodeFSP.readFile(attachment.path, "utf8")).toBe("hello");
    expect((await NodeFSP.stat(attachment.path)).mode & 0o777).toBe(0o600);
    await staged.discard();
    expect(
      (await NodeFSP.readdir(NodePath.join(directory, "rewound-attachments"))).filter(
        (name) => name !== ".gitignore",
      ),
    ).toEqual([]);
    let reads = 0;
    await expect(
      stageRewindAttachments({
        directory,
        attachments: [source, source],
        maxFileBytes: 1024,
        read: async () => {
          reads += 1;
          if (reads === 2) throw new Error("Expired attachment");
          return new TextEncoder().encode("hello");
        },
      }),
    ).rejects.toThrow("Expired attachment");
    expect(
      (await NodeFSP.readdir(NodePath.join(directory, "rewound-attachments"))).filter(
        (name) => name !== ".gitignore",
      ),
    ).toEqual([]);
    const retained = await stageRewindAttachments({
      directory,
      attachments: [source],
      maxFileBytes: 1024,
      read: async () => new TextEncoder().encode("hello"),
    });
    retained.retain();
    await retained.discard();
    expect(await NodeFSP.readFile(retained.attachments[0]!.path, "utf8")).toBe("hello");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

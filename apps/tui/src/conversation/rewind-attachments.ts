// @effect-diagnostics nodeBuiltinImport:off -- Rewound attachments are private local files retained by the durable composer draft.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import { preparePrivateDirectory } from "../connections/files.ts";
import {
  inspectLocalAttachment,
  localAttachmentProblem,
  type LocalAttachment,
} from "../runtime/attachments.ts";

export async function stageRewindAttachments(options: {
  directory: string;
  attachments: readonly ChatAttachment[];
  read: (attachment: ChatAttachment) => Promise<Uint8Array>;
  maxFileBytes: number;
}) {
  const directory = NodePath.join(options.directory, "rewound-attachments");
  if (options.attachments.length > 0) await preparePrivateDirectory(directory);
  const paths: string[] = [];
  const attachments: LocalAttachment[] = [];
  let retained = false;
  const discard = async () => {
    if (!retained) await Promise.all(paths.map((path) => NodeFSP.rm(path, { force: true })));
  };
  try {
    for (const source of options.attachments) {
      if (source.type !== "image" && source.type !== "file")
        throw new Error("This prompt contains an attachment that cannot be restored.");
      const bytes = await options.read(source);
      const maximum =
        source.type === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : Math.min(options.maxFileBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
      if (bytes.byteLength === 0 || bytes.byteLength > maximum)
        throw new Error(
          `Cannot restore ${source.name}: the attachment exceeds this environment's limit.`,
        );
      const path = NodePath.join(directory, SecureRandom.uuidV4Unsafe());
      await NodeFSP.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
      attachments.push({
        ...(await inspectLocalAttachment(path, maximum)),
        name: source.name,
        type: source.type,
        mimeType: source.mimeType,
      });
    }
    const problem = localAttachmentProblem(attachments);
    if (problem) throw new Error(problem);
    return {
      attachments,
      retain: () => {
        retained = true;
      },
      discard,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

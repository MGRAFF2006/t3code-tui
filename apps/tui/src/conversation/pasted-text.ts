// @effect-diagnostics nodeBuiltinImport:off -- Generated text attachments belong to this terminal's private client directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { TextareaRenderable } from "@opentui/core";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import {
  nextPastedTextFileName,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@t3tools/client-runtime/text-paste";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { preparePrivateDirectory } from "../connections/files.ts";
import { inspectLocalAttachment } from "../runtime/attachments.ts";

const textEncoder = new TextEncoder();

export function readComposerTextSelection(editor: TextareaRenderable) {
  const native = editor.getSelection();
  const start = native?.start ?? editor.cursorOffset;
  const end = native?.end ?? start;
  // OpenTUI's offsets count display cells, while paste limits count UTF-16 characters.
  const first = editor.editBuffer.getTextRange(0, Math.min(start, end)).length;
  return {
    start: first,
    end: start === end ? first : editor.editBuffer.getTextRange(0, Math.max(start, end)).length,
  };
}

export function planComposerTextPaste(input: {
  text: string;
  value: string;
  selection: { start: number; end: number };
  maxFileBytes: number | null;
  attachmentCount: number;
  existingNames: ReadonlyArray<string>;
  reservedAttachmentCount?: number | undefined;
  bypassAutoAttachment?: boolean | undefined;
}) {
  const wouldExceedInputLimit = wouldTextPasteExceedLimit({
    valueLength: input.value.length,
    selection: input.selection,
    textLength: input.text.length,
    maxLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  });
  if (
    pastedTextDisposition({
      text: input.text,
      canAttach: true,
      bypassAutoAttachment: Boolean(input.bypassAutoAttachment),
      wouldExceedInputLimit,
    }) === "inline"
  )
    return { kind: "inline" } as const;

  if (
    input.maxFileBytes === null ||
    input.attachmentCount + (input.reservedAttachmentCount ?? 0) >=
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    return wouldExceedInputLimit
      ? ({
          kind: "blocked",
          message:
            "Pasted text is too large for this message. Remove some text or an attachment, then paste again.",
        } as const)
      : ({ kind: "inline" } as const);

  const sizeBytes = textEncoder.encode(input.text).byteLength;
  if (sizeBytes > clampFileAttachmentUploadBytes(input.maxFileBytes))
    return wouldExceedInputLimit
      ? ({
          kind: "blocked",
          message:
            "Pasted text is too large to attach. Reduce the clipboard contents or save a smaller excerpt as a file.",
        } as const)
      : ({ kind: "inline" } as const);

  return {
    kind: "attachment",
    name: nextPastedTextFileName(input.existingNames),
    sizeBytes,
  } as const;
}

export async function stagePastedTextAttachment(
  configDirectory: string,
  text: string,
  options: { name: string; maxFileBytes: number },
) {
  const bytes = textEncoder.encode(text);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > Math.min(options.maxFileBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES)
  )
    throw new Error("The pasted text exceeds this environment's file attachment limit.");
  if (!/^pasted-text(?:-[1-9]\d*)?\.txt$/.test(options.name))
    throw new Error("Invalid pasted text attachment name.");
  const directory = NodePath.join(configDirectory, "pasted-text");
  await preparePrivateDirectory(directory);
  const path = NodePath.join(directory, `${SecureRandom.uuidV4Unsafe()}.txt`);
  let retained = false;
  let created = false;
  const discard = async () => {
    if (created && !retained) await NodeFSP.rm(path, { force: true });
  };
  try {
    const file = await NodeFSP.open(path, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    const attachment = {
      ...(await inspectLocalAttachment(path, options.maxFileBytes)),
      name: options.name,
      mimeType: "text/plain",
    };
    return {
      attachment,
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

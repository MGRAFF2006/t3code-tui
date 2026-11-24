import { ARCHIVE_ENTRY_MAX_BYTES, boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import { terminalOutputPlainText } from "@t3tools/shared/terminalOutput";
import { hexPreview } from "./file-preview.logic.ts";

export async function readZipPreview(bytes: Uint8Array) {
  return boundedZip(bytes.slice().buffer, ARCHIVE_ENTRY_MAX_BYTES);
}

export type ZipPreview = Awaited<ReturnType<typeof readZipPreview>>;

export function zipRows(archive: ZipPreview, directory: string, query = "") {
  const rows = new Map<string, { path: string; directory: boolean; size: number }>();
  const needle = query.toLocaleLowerCase();
  for (const [path, file] of archive) {
    if (!path.startsWith(directory) || path === directory) continue;
    if (needle) {
      if (!path.toLocaleLowerCase().includes(needle)) continue;
      rows.set(path, { path, directory: file.directory, size: file.bytes.length });
      continue;
    }
    const slash = path.indexOf("/", directory.length);
    const rowPath = slash < 0 ? path : path.slice(0, slash + 1);
    rows.set(rowPath, {
      path: rowPath,
      directory: slash >= 0 || file.directory,
      size: slash >= 0 || file.directory ? 0 : file.bytes.length,
    });
  }
  return [...rows.values()].sort(
    (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
  );
}

const TEXT_PREVIEW_BYTES = 1024 * 1024;

export function zipEntryPreview(bytes: Uint8Array, hex = false) {
  if (hex) return hexPreview(bytes);
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, TEXT_PREVIEW_BYTES),
      { stream: bytes.length > TEXT_PREVIEW_BYTES },
    );
    return `${terminalOutputPlainText(text)}${bytes.length > TEXT_PREVIEW_BYTES ? "\n\nText preview limited to 1 MiB. Use hex to inspect bytes." : ""}`;
  } catch {
    return null;
  }
}

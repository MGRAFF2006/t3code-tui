import { describe, expect, it } from "vite-plus/test";
import { readZipPreview, zipEntryPreview, zipRows } from "./archive.logic.ts";

const ZIP =
  "UEsDBBQAAAAIAM5heF2STf6ZCgAAAAgAAAAPAAAAZG9jcy9yZWFkbWUudHh0C0/NSc7PTeUCAFBLAwQUAAAACADOYXhdAAAAAAIAAAAAAAAABgAAAGVtcHR5LwMAUEsDBBQAAAAIAM5heF1mVb5tBQAAAAMAAAAJAAAAaW1hZ2UuYmluY/jvCABQSwMEFAAACAgAzmF4XSbB4boLAAAACQAAAAsAAABncsO8w59lLnR4dHMvLUnNUwhJTAcAUEsBAhQDFAAAAAgAzmF4XZJN/pkKAAAACAAAAA8AAAAAAAAAAAAAAIABAAAAAGRvY3MvcmVhZG1lLnR4dFBLAQIUAxQAAAAIAM5heF0AAAAAAgAAAAAAAAAGAAAAAAAAAAAAEAD9QTcAAABlbXB0eS9QSwECFAMUAAAACADOYXhdZlW+bQUAAAADAAAACQAAAAAAAAAAAAAAgAFdAAAAaW1hZ2UuYmluUEsBAhQDFAAACAgAzmF4XSbB4boLAAAACQAAAAsAAAAAAAAAAAAAAIABiQAAAGdyw7zDn2UudHh0UEsFBgAAAAAEAAQA4QAAAL0AAAAAAA==";

describe("native ZIP browsing", () => {
  it("opens real compressed members, navigates implicit and empty folders, and searches nested paths", async () => {
    const archive = await readZipPreview(
      Uint8Array.from(atob(ZIP), (character) => character.charCodeAt(0)),
    );
    expect(zipRows(archive, "")).toEqual([
      { path: "docs/", directory: true, size: 0 },
      { path: "empty/", directory: true, size: 0 },
      { path: "grüße.txt", directory: false, size: 9 },
      { path: "image.bin", directory: false, size: 3 },
    ]);
    expect(zipRows(archive, "docs/")).toEqual([
      { path: "docs/readme.txt", directory: false, size: 8 },
    ]);
    expect(zipRows(archive, "empty/")).toEqual([]);
    expect(zipRows(archive, "", "README").map((row) => row.path)).toEqual(["docs/readme.txt"]);
    expect(zipRows(archive, "docs/", "image")).toEqual([]);
    expect(zipEntryPreview(archive.get("docs/readme.txt")!.bytes)).toBe("Welcome\n");
    expect(zipEntryPreview(archive.get("image.bin")!.bytes)).toBeNull();
    expect(zipEntryPreview(archive.get("image.bin")!.bytes, true)).toContain("00 ff 41");
    await expect(readZipPreview(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow(
      "not a readable ZIP",
    );
    const crowded = Uint8Array.from(atob(ZIP), (character) => character.charCodeAt(0));
    new DataView(crowded.buffer).setUint16(crowded.byteLength - 12, 2049, true);
    await expect(readZipPreview(crowded)).rejects.toThrow("more than 2,048 entries");
  });

  it("keeps binary and damaged encodings out of text and bounds rendered text without executing escapes", () => {
    expect(zipEntryPreview(new Uint8Array([0xff]))).toBeNull();
    expect(zipEntryPreview(new Uint8Array([0]))).toBeNull();
    expect(zipEntryPreview(new TextEncoder().encode("\u001b[31mRed\u001b[0m"))).toBe("Red");
    expect(zipEntryPreview(new Uint8Array())).toBe("");
    const long = new Uint8Array(1024 * 1024 + 1).fill(65);
    const preview = zipEntryPreview(long)!;
    expect(preview).toContain("Text preview limited to 1 MiB");
    expect(preview).not.toContain("A".repeat(1024 * 1024 + 1));
  });
});

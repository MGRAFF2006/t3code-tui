// @effect-diagnostics nodeBuiltinImport:off -- Bun embeds these notices when compiling the terminal client.
import * as NodeFSP from "node:fs/promises";
import { generateThirdPartyLicenseManifest } from "../../../../scripts/lib/third-party-licenses.ts";

export async function terminalLicenseManifest() {
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: new URL("../../../../third-party-licenses.config.json", import.meta.url),
    packageManifests: [
      { bundle: "terminal", path: new URL("../../package.json", import.meta.url) },
    ],
    bundleName: "terminal",
  });
  const [license, opencode] = await Promise.all([
    NodeFSP.readFile(new URL("../../../../LICENSE", import.meta.url), "utf8"),
    NodeFSP.readFile(new URL("../../LICENSE.opencode", import.meta.url), "utf8"),
  ]);
  return {
    ...manifest,
    entries: [
      {
        kind: "custom" as const,
        bundles: ["terminal"],
        name: "T3 Code",
        version: null,
        license: "MIT",
        sourceUrl: "https://github.com/pingdotgg/t3code",
        noticeText: license,
      },
      {
        kind: "custom" as const,
        bundles: ["terminal"],
        name: "opencode terminal design",
        version: null,
        license: "MIT",
        sourceUrl: "https://github.com/anomalyco/opencode",
        noticeText: opencode,
      },
      ...manifest.entries,
    ],
  };
}

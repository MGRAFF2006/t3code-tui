import { terminalLicenseManifest } from "./about-licenses.macro.ts" with { type: "macro" };
import {
  filterThirdPartyLicenseEntries,
  type ThirdPartyLicenseEntry,
} from "@t3tools/shared/thirdPartyLicenses";
import type { FeatureProps } from "../ui/controller.ts";

const manifest = await terminalLicenseManifest();

export function licenseActions(props: FeatureProps, query = "") {
  const entries = filterThirdPartyLicenseEntries(manifest.entries, query);
  const showNotice = (entry: ThirdPartyLicenseEntry) => {
    props.ui.choose(entry.name, [
      {
        title: "Read license notice",
        run: () =>
          props.ui.text(
            `${entry.name}${entry.version ? ` ${entry.version}` : ""} · ${entry.license}`,
            entry.noticeText,
          ),
      },
      ...(entry.sourceUrl && props.ui.openBrowser
        ? [
            {
              title: "Open project source",
              description: entry.sourceUrl,
              run: () => props.ui.openBrowser!(entry.sourceUrl!),
            },
          ]
        : []),
    ]);
  };
  props.ui.choose(`Terminal open-source notices · ${entries.length}/${manifest.entries.length}`, [
    {
      title: "Search notices…",
      description: query || "Package, version or license",
      run: () =>
        props.ui.form({
          title: "Search open-source notices",
          fields: [{ name: "query", label: "Search", value: query }],
          submitLabel: "Search",
          onSubmit: async ({ query: next = "" }) => licenseActions(props, next),
        }),
    },
    ...(query ? [{ title: "Clear search", run: () => licenseActions(props) }] : []),
    ...entries.map((entry) => ({
      title: entry.name,
      description: `${entry.version ?? ""} · ${entry.license}`.replace(/^ · /, ""),
      run: () => showNotice(entry),
    })),
  ]);
}

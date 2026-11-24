import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import packageJson from "../../package.json" with { type: "json" };
import type { FeatureProps } from "../ui/controller.ts";
import { destinationGuard } from "./common.tsx";

export function aboutActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  const config = props.state()?.config;
  props.ui.choose("About T3 Code", [
    {
      title: "Version and environment",
      description: `Terminal ${packageJson.version} · Server ${config?.environment.serverVersion ?? "Unavailable"}`,
      run: () => {
        guard();
        const current = props.state()?.config;
        const environment = current?.environment;
        props.ui.text(
          "About T3 Code",
          [
            `Terminal client: ${packageJson.name} ${packageJson.version}`,
            `Client orchestration protocol: ${ORCHESTRATION_PROTOCOL_VERSION}`,
            "",
            `Server: ${environment?.label ?? props.state()?.label ?? "Disconnected"}`,
            `Server version: ${environment?.serverVersion ?? "Unavailable"}`,
            `Server protocol: ${environment?.orchestrationProtocolVersion ?? "Unavailable"}`,
            `Environment ID: ${props.state()?.environmentId ?? "None"}`,
            ...(environment
              ? [`Platform: ${environment.platform.os} ${environment.platform.arch}`]
              : []),
            ...(current?.hostname ? [`Host: ${current.hostname}`] : []),
            ...(current?.managedPolicy
              ? [`Managed by: ${current.managedPolicy.organization}`]
              : []),
          ].join("\n"),
        );
      },
    },
    {
      title: "Open-source licenses",
      description: "Notices packaged with this terminal client.",
      run: () =>
        void props.ui.run(async () => {
          const { licenseActions } = await import("./about-licenses.ts");
          licenseActions(props);
        }),
    },
  ]);
}

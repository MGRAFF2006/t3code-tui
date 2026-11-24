import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { FeatureProps } from "../ui/controller.ts";
import type { ConnectionDiagnostics } from "./connection-diagnostics.logic.ts";

export async function connectionDiagnosticsActions(
  props: FeatureProps,
  id = props.state()?.environmentId,
) {
  const origin = props.state()?.environmentId;
  const guard = () => {
    if (props.state()?.environmentId !== origin)
      throw new Error("The selected environment changed. Open connection diagnostics again.");
  };
  let snapshot: ConnectionDiagnostics;
  async function refresh() {
    guard();
    if (!id) return chooseEnvironment();
    const result = await props.client.connectionDiagnostics(EnvironmentId.make(id));
    guard();
    snapshot = result;
    show();
  }
  async function chooseEnvironment(use = false) {
    guard();
    const environments = await props.client.environments();
    guard();
    props.ui.choose(
      "Connection diagnostics",
      environments.map((entry) => ({
        title: entry.label,
        description: entry.environmentId,
        run: () =>
          void props.ui.run(async () => {
            guard();
            if (!use) return connectionDiagnosticsActions(props, entry.environmentId);
            await props.ui.openEnvironment(entry.environmentId);
          }),
      })),
    );
  }
  function details() {
    guard();
    const diagnosis = snapshot.diagnosis;
    props.ui.text(
      `Connection · ${snapshot.label}`,
      [
        `${snapshot.label} · ${snapshot.phase}`,
        `Environment: ${snapshot.environmentId}`,
        `Saved connection: ${snapshot.enabled ? "Enabled" : "Disabled"}`,
        `Network: ${snapshot.network}`,
        ...(snapshot.stage ? [`Stage: ${snapshot.stage}`] : []),
        `Attempts: ${snapshot.attempts}`,
        ...(snapshot.retryAt === null
          ? []
          : [`Next retry: ${DateTime.formatIso(DateTime.makeUnsafe(snapshot.retryAt))}`]),
        ...(snapshot.serverVersion ? [`Server version: ${snapshot.serverVersion}`] : []),
        "",
        ...(diagnosis
          ? [
              diagnosis.headline,
              "",
              ...diagnosis.hops.map((hop) => `${hop.label}: ${hop.result}`),
              "",
              ...diagnosis.steps.map((step, index) => `${index + 1}. ${step}`),
              "",
              ...diagnosis.facts.map(([name, value]) => `${name}: ${value}`),
            ]
          : ["No connection failure is currently reported."]),
      ].join("\n"),
    );
  }
  function protocol() {
    guard();
    props.ui.choose("Protocol compatibility and recovery", [
      {
        title: "Compatibility details and next steps",
        description:
          snapshot.unsupported ??
          `Client protocol ${ORCHESTRATION_PROTOCOL_VERSION} · Server protocol ${snapshot.serverProtocol ?? "unavailable"}`,
        run: () =>
          props.ui.text(
            "Protocol compatibility",
            [
              `Host: ${snapshot.label}`,
              `Client orchestration protocol: ${ORCHESTRATION_PROTOCOL_VERSION}`,
              `Server orchestration protocol: ${snapshot.serverProtocol ?? "Unavailable while disconnected"}`,
              `Server version: ${snapshot.serverVersion ?? "Unavailable while disconnected"}`,
              "",
              snapshot.unsupported ??
                (snapshot.serverProtocol === null
                  ? "Reconnect to read the server's protocol."
                  : snapshot.serverProtocol === ORCHESTRATION_PROTOCOL_VERSION
                    ? "The connected server uses this client's orchestration protocol."
                    : "Client and server protocols differ."),
              "",
              ...(snapshot.serverUpdateRequired
                ? ["Update T3 Code on the host to a release compatible with this client."]
                : snapshot.unsupported
                  ? [
                      "Use a terminal client and host release that support the same orchestration protocol.",
                    ]
                  : []),
              "After installing compatible versions, retry this connection. You can use another saved environment while this host is unavailable.",
            ].join("\n"),
          ),
      },
      {
        title: "Retry connection",
        run: () =>
          void props.ui.run(async () => {
            guard();
            await props.client.retryEnvironment(snapshot.environmentId);
            guard();
            props.ui.notify(
              `Retry requested for ${snapshot.label}. Refresh diagnostics to inspect the result.`,
            );
          }),
      },
      {
        title: "Use another saved environment…",
        run: () => void props.ui.run(() => chooseEnvironment(true)),
      },
    ]);
  }
  function show() {
    guard();
    props.ui.choose(`Connection diagnostics · ${snapshot.label}`, [
      {
        title: "Status and recovery steps",
        description: snapshot.diagnosis?.headline ?? `${snapshot.phase} · ${snapshot.network}`,
        run: details,
      },
      {
        title: snapshot.unsupported ? "Protocol recovery required" : "Protocol compatibility",
        description: snapshot.unsupported ?? `Client protocol ${ORCHESTRATION_PROTOCOL_VERSION}`,
        run: protocol,
      },
      { title: "Refresh diagnostics", run: () => void props.ui.run(refresh) },
      {
        title: "Retry connection",
        run: () =>
          void props.ui.run(async () => {
            guard();
            await props.client.retryEnvironment(snapshot.environmentId);
            guard();
            props.ui.notify(`Retry requested for ${snapshot.label}.`);
          }),
      },
      {
        title: "Inspect another environment…",
        run: () => void props.ui.run(() => chooseEnvironment()),
      },
      ...(snapshot.diagnosis?.moreInfoUrl && props.ui.openBrowser
        ? [
            {
              title: "Open connection troubleshooting",
              description: snapshot.diagnosis.moreInfoUrl,
              run: () => props.ui.openBrowser!(snapshot.diagnosis!.moreInfoUrl!),
            },
          ]
        : []),
      ...snapshot.routes.map((route, index) => ({
        title: `${index + 1}. ${route.label}${route.active ? " · Active" : ""}${route.refused ? " · Credential refused" : ""}`,
        description: route.address ?? route.kind,
        run: () =>
          props.ui.text(
            "Connection route",
            [
              route.label,
              route.kind,
              route.address ?? "No direct address",
              route.active ? "This is the active route." : "This route is saved as an alternative.",
              route.refused
                ? "The host refused this device's credential on this route. Pair again through Connections."
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      })),
    ]);
  }
  await refresh();
}

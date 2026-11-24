import {
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabelText,
  connectionRoutes,
  presentConnectionDiagnosis,
  type ConnectionCatalogEntry,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";

export function credentialFreeAddress(value: string | null) {
  if (value === null || !/^[a-z]+:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Invalid route address";
  }
}

export function connectionDiagnosticSummary(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
  prepared: Pick<PreparedConnection, "descriptor" | "target"> | null,
) {
  const routes = connectionRoutes(entry);
  const activeId = prepared ? connectionRouteId(prepared.target) : null;
  const via = entry.target._tag === "RelayConnectionTarget" ? "relay" : "direct";
  return {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    enabled: entry.enabled,
    phase: state.phase,
    network: state.network,
    stage: state.stage,
    attempts: state.attempt,
    retryAt: state.retryAt,
    serverVersion: prepared?.descriptor?.serverVersion ?? null,
    serverProtocol: prepared?.descriptor?.orchestrationProtocolVersion ?? null,
    unsupported:
      entry.unsupportedReason ??
      (state.lastFailure?.reason === "unsupported" ? state.lastFailure.message : null),
    serverUpdateRequired:
      entry.serverUpdateRequired === true ||
      (state.lastFailure?._tag === "ConnectionBlockedError" &&
        state.lastFailure.serverUpdateRequired === true),
    diagnosis: presentConnectionDiagnosis({
      hostLabel: entry.target.label,
      state,
      via,
      serverVersion: prepared?.descriptor?.serverVersion,
    }),
    routes: routes.map((route) => {
      const id = connectionRouteId(route.target);
      return {
        id,
        label: connectionRouteLabelText(route),
        kind: connectionRouteKind(route),
        address: credentialFreeAddress(connectionRouteAddress(route)),
        active: id === activeId,
        refused: state.refusedRouteIds.includes(id),
      };
    }),
  };
}

export type ConnectionDiagnostics = ReturnType<typeof connectionDiagnosticSummary>;

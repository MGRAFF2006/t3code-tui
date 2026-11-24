import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { connectionDiagnosticSummary } from "./connection-diagnostics.logic.ts";

describe("native connection diagnostic projection", () => {
  it("reports active/refused routes and protocol recovery without exposing route credentials or tokens", () => {
    const environmentId = EnvironmentId.make("host");
    const target = new BearerConnectionTarget({
      environmentId,
      connectionId: "direct",
      label: "Host",
    });
    const route = new BearerConnectionProfile({
      environmentId,
      connectionId: "direct",
      label: "Host",
      httpBaseUrl: "https://name:password@host.invalid/base?token=private#secret",
      wsBaseUrl: "wss://host.invalid/ws?token=also-private",
    });
    const entry: ConnectionCatalogEntry = {
      target,
      profile: Option.some(route),
      enabled: true,
      serverUpdateRequired: true,
    };
    const summary = connectionDiagnosticSummary(
      entry,
      {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "blocked",
        attempt: 3,
        refusedRouteIds: ["direct"],
        lastFailure: new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Host needs a newer server",
          serverUpdateRequired: true,
        }),
      },
      { target },
    );
    expect(summary).toMatchObject({
      phase: "blocked",
      attempts: 3,
      serverUpdateRequired: true,
      unsupported: "Host needs a newer server",
      routes: [{ address: "https://host.invalid/base", active: true, refused: true }],
    });
    expect(summary.diagnosis?.steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toMatch(
      /password|private|secret|wsBaseUrl|httpAuthorization/,
    );
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- Exercises the client with a temporary, disposable connection catalogue.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import * as ClientPlatform from "../runtime/platform.ts";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfig,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { createTuiClient } from "../runtime/client.ts";
import * as RpcBridge from "../rpc/bridge.ts";
import {
  v2Project,
  v2Projection,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";

describe("captured terminal launch destinations", () => {
  it.effect(
    "uses the destination's defaults and remote-tip policy while keeping the current machine and model selected",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-launch-"))),
        (configDir) =>
          Effect.gen(function* () {
            const destination = EnvironmentId.make("destination");
            const origin = EnvironmentId.make("origin");
            let selectionGate:
              | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
              | undefined;
            const platformFactory = ClientPlatform.createClientLayer;
            using _platform = vi
              .spyOn(ClientPlatform, "createClientLayer")
              .mockImplementation(async (...args) => {
                const original = await platformFactory(...args);
                const registry = Layer.effect(
                  EnvironmentRegistry.EnvironmentRegistry,
                  Effect.gen(function* () {
                    const service = yield* EnvironmentRegistry.EnvironmentRegistry;
                    return {
                      ...service,
                      setEnabled: (id, enabled) =>
                        Effect.gen(function* () {
                          const gate = selectionGate;
                          if (gate && id === destination) {
                            yield* Deferred.succeed(gate.entered, undefined);
                            yield* Deferred.await(gate.release);
                          }
                          yield* service.setEnabled(id, enabled);
                        }),
                    } satisfies typeof service;
                  }),
                ).pipe(Layer.provide(original.layer));
                return { ...original, layer: Layer.merge(original.layer, registry) };
              });
            const remoteModel = {
              instanceId: ProviderInstanceId.make("remote-provider"),
              model: "remote-default",
            };
            const project = { ...v2Project, workspaceRoot: "/projects/existing" };
            const config = {
              environment: { environmentId: destination, label: "Destination" },
              providers: [],
              newProjectsRoot: "/projects",
              settings: {
                ...DEFAULT_SERVER_SETTINGS,
                defaultThreadEnvMode: "worktree",
                defaultModelSelection: remoteModel,
                defaultRuntimeMode: "auto-accept-edits",
                newWorktreesStartFromOrigin: true,
              },
              shellOlderSettled: true,
            } as unknown as ServerConfig;
            const shell = {
              ...v2ShellSnapshot,
              projects: [project],
              threads: [],
              olderSettled: {
                before: "2026-06-01T00:00:00Z",
                asOfSequence: 0,
                counts: [{ projectId: project.id, count: 1 }],
              },
            };
            using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (url.pathname === "/api/auth/session")
                return Response.json({
                  authenticated: true,
                  auth: {
                    policy: "remote-reachable",
                    bootstrapMethods: [],
                    sessionMethods: [],
                    sessionCookieName: "fixture",
                  },
                });
              return Response.json({
                environmentId: url.hostname === "destination.invalid" ? destination : origin,
                label: url.hostname,
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                orchestrationProtocolVersion: 0,
                capabilities: {},
              });
            });
            const bridgeFactory = RpcBridge.createRpcBridge;
            const launched: {
              environmentId: EnvironmentId;
              input: OrchestrationV2ThreadLaunchInput;
            }[] = [];
            const stopped = vi.fn();
            using _bridge = vi.spyOn(RpcBridge, "createRpcBridge").mockImplementation((...args) => {
              const bridge = bridgeFactory(...args);
              return {
                ...bridge,
                invoke: async (method, input) => {
                  if (args[2]() !== destination) return bridge.invoke(method, input);
                  if (method === WS_METHODS.serverGetConfig) return config;
                  if (method === WS_METHODS.vcsRefreshStatus)
                    return { isRepo: true, refName: "main" };
                  if (method === ORCHESTRATION_V2_WS_METHODS.launchThread) {
                    launched.push({
                      environmentId: args[2](),
                      input: input as OrchestrationV2ThreadLaunchInput,
                    });
                    return {
                      threadId: v2Projection.thread.id,
                      projection: v2Projection,
                      resumed: false,
                    };
                  }
                  return bridge.invoke(method, input);
                },
                stream: (method, input, onValue, onError) => {
                  if (
                    args[2]() !== destination ||
                    method !== ORCHESTRATION_V2_WS_METHODS.subscribeShell
                  )
                    return bridge.stream(method, input, onValue, onError);
                  onValue({ kind: "synchronized" });
                  onValue({ kind: "snapshot", snapshot: shell });
                  return stopped;
                },
              };
            });
            const seed = yield* Effect.promise(() =>
              createTuiClient({
                configDir,
                url: "http://destination.invalid",
                token: "fixture-token",
              }),
            );
            seed.close();
            const client = yield* Effect.promise(() =>
              createTuiClient({ configDir, url: "http://origin.invalid", token: "fixture-token" }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
            const preferred = {
              instanceId: ProviderInstanceId.make("visible-provider"),
              model: "visible-model",
            };
            yield* Effect.promise(() => client.setModel(preferred));
            const snapshot = client.snapshot();
            expect(snapshot.environmentId).toBe(origin);
            const prepared = yield* Effect.promise(() => client.prepareThreadLaunch(destination));
            expect(prepared.environmentId).toBe(destination);
            expect(client.snapshot().environmentId).toBe(origin);
            expect(client.snapshot().selectedThreadId).toBe(snapshot.selectedThreadId);
            yield* Effect.promise(() =>
              client.createThread(project.id, "Remote thread", undefined, {
                environmentId: destination,
              }),
            );
            expect(launched).toHaveLength(1);
            expect(launched[0]).toMatchObject({
              environmentId: destination,
              input: {
                projectId: project.id,
                modelSelection: remoteModel,
                runtimeMode: "auto-accept-edits",
                workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
              },
            });
            expect(client.snapshot().environmentId).toBe(origin);
            expect(stopped).toHaveBeenCalledTimes(2);
            selectionGate = {
              entered: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
            };
            let current = true;
            const cancelled = yield* Effect.forkChild(
              Effect.promise(() => client.selectEnvironment(destination, () => current)),
            );
            yield* Deferred.await(selectionGate.entered);
            current = false;
            yield* Deferred.succeed(selectionGate.release, undefined);
            yield* Fiber.join(cancelled);
            expect(client.snapshot().environmentId).toBe(origin);
            selectionGate = {
              entered: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
            };
            const superseded = yield* Effect.forkChild(
              Effect.promise(() => client.selectEnvironment(destination)),
            );
            yield* Deferred.await(selectionGate.entered);
            yield* Effect.promise(() => client.selectEnvironment(origin));
            yield* Deferred.succeed(selectionGate.release, undefined);
            yield* Fiber.join(superseded);
            expect(client.snapshot().environmentId).toBe(origin);
          }),
        (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      ),
  );
});

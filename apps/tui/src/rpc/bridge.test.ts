import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import * as Rpc from "@t3tools/client-runtime/rpc";
import * as Runtime from "@t3tools/client-runtime/state/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { createRpcBridge } from "./bridge.ts";

it.effect("delivers every event in a stream chunk and cancels its captured subscription", () =>
  Effect.gen(function* () {
    const consumed = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const frames = [1, 2, 3].map((snapshotSequence) => ({
      kind: "snapshot" as const,
      snapshotSequence,
      projection: v2Projection,
    }));
    using _source = vi
      .spyOn(Rpc, "subscribe")
      .mockReturnValue(
        Stream.fromIterable(frames).pipe(
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain),
          ),
          Stream.concat(Stream.never),
          Stream.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      );
    using _permissions = vi.spyOn(Runtime, "createCommandPermissions").mockReturnValue({
      requiredScopes: () => [],
      permissionAtom: () => Atom.make(true),
      authorize: () => Effect.void,
    });
    const connections = {
      runStream: <A, E, R>(_id: EnvironmentId, stream: Stream.Stream<A, E, R>) => stream,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, connections),
    );
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const received: unknown[] = [];
    const bridge = createRpcBridge(
      runtime,
      registry,
      () => EnvironmentId.make("captured-host"),
      (atom, listener) => registry.subscribe(atom, listener, { immediate: true }),
    );
    const detach = bridge.stream(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      { threadId: v2Projection.thread.id },
      (frame) => received.push(frame),
    );
    yield* Deferred.await(consumed);
    expect(received).toEqual(frames);
    detach();
    yield* Deferred.await(stopped);
  }),
);

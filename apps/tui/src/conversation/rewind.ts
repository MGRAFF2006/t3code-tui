import type {
  CommandId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

export async function waitForConversationRewind(options: {
  projection: OrchestrationV2ThreadProjection;
  commandId: CommandId;
  turnCount: number;
  subscribe: (
    onFrame: (frame: OrchestrationV2ThreadStreamItem) => void,
    onError: (error: Error) => void,
  ) => () => void;
  dispatch: () => Promise<unknown>;
}) {
  const { projection: initial, commandId, turnCount } = options;
  const witness = initial.runs.findLast(
    (run) =>
      run.ordinal > turnCount &&
      ["completed", "failed", "interrupted", "cancelled"].includes(run.status),
  );
  if (!witness) throw new Error("The thread changed. Select the prompt to rewind again.");
  const providerThreadId = initial.thread.activeProviderThreadId;
  const providerThread = initial.providerThreads.find((thread) => thread.id === providerThreadId);
  const initialProviderThreadIds = new Set(initial.providerThreads.map((thread) => thread.id));
  await new Promise<void>((resolve, reject) => {
    let projection: OrchestrationV2ThreadProjection | null = initial;
    let accepted = false;
    let finished = false;
    let stop = () => {};
    let timer: Fiber.Fiber<void> | undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      stop();
      if (timer) Effect.runFork(Fiber.interrupt(timer));
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      if (!projection || projection.thread.deletedAt !== null) {
        finish(new Error("The conversation was deleted while rewinding."));
        return;
      }
      const failure = projection.thread.rollbackFailure;
      if (failure?.requestId === commandId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        projection.thread.rollbackRequestId === commandId &&
        projection.runs.some((run) => run.id === witness.id && run.status === "rolled_back") &&
        projection.providerThreads.some(
          (thread) =>
            (thread.id === providerThreadId ||
              (turnCount === 0 &&
                thread.ownerNodeId === null &&
                thread.appThreadId === initial.thread.id &&
                thread.providerInstanceId === providerThread?.providerInstanceId &&
                !initialProviderThreadIds.has(thread.id))) &&
            thread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
        )
      )
        finish();
    };
    try {
      const cancel = options.subscribe((frame) => {
        if (finished) return;
        if (frame.kind === "snapshot") {
          if (frame.projection.thread.id !== initial.thread.id) {
            finish(
              new Error(
                "The rewind returned another conversation. Open the original thread again.",
              ),
            );
            return;
          }
          projection = frame.projection;
        } else if (frame.kind === "event")
          projection = applyOrchestrationV2ProjectionEvent(projection, frame.event, {
            partialTimeline: true,
          });
        inspect();
      }, finish);
      stop = cancel;
      if (finished) {
        cancel();
        return;
      }
      timer = Effect.runFork(
        Effect.sleep("2 minutes").pipe(
          Effect.andThen(
            Effect.sync(() =>
              finish(
                new Error(
                  "Could not confirm the rewind. Check the original conversation before trying again.",
                ),
              ),
            ),
          ),
        ),
      );
      void options.dispatch().then(() => {
        accepted = true;
        inspect();
      }, finish);
    } catch (error) {
      finish(error);
    }
  });
}

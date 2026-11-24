import {
  CommandId,
  MessageId,
  isProviderNativeSubagentThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  canResumeThread,
  deriveResumableRunId,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import * as SecureRandom from "effect/crypto/SecureRandom";

export function conversationContinuation(projection: OrchestrationV2ThreadProjection) {
  const runId = deriveResumableRunId(projection, deriveThreadStructureRuntime(projection));
  const queue = deriveThreadQueueWorkflowState(projection);
  return {
    runId,
    heldQueue: queue.isHeld,
    available:
      queue.canSendNow &&
      !isProviderNativeSubagentThread(projection.thread) &&
      canResumeThread(projection, runId, queue.isHeld),
  };
}

export async function continueConversation(
  projection: OrchestrationV2ThreadProjection,
  dispatch: (command: OrchestrationV2Command) => Promise<unknown>,
) {
  const state = conversationContinuation(projection);
  if (!state.available)
    throw new Error(
      "This thread cannot resume now. Resolve pending requests or stop active work first.",
    );
  const threadId = projection.thread.id;
  if (state.runId !== null)
    await dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(SecureRandom.uuidV4Unsafe()),
      manualContinuationOfRunId: state.runId,
      text: "",
      attachments: [],
      modelSelection: projection.thread.modelSelection,
      dispatchMode: { type: "start_immediately" },
    });
  if (state.heldQueue)
    await dispatch({
      type: "queue.resume",
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      threadId,
    });
}

import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import { request, subscribe } from "../rpc/request.ts";
import type { createRpcBridge } from "../rpc/bridge.ts";

export interface ThreadLaunchContext {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly shell: OrchestrationV2ShellSnapshot;
}

export async function readThreadLaunchContext(
  transport: ReturnType<typeof createRpcBridge>,
  environmentId: EnvironmentId,
): Promise<ThreadLaunchContext> {
  const config = await request(transport, WS_METHODS.serverGetConfig, {});
  let stop: (() => void) | undefined;
  try {
    const shell = await new Promise<OrchestrationV2ShellSnapshot>((resolve, reject) => {
      stop = subscribe(
        transport,
        ORCHESTRATION_V2_WS_METHODS.subscribeShell,
        {
          ...(config.shellThreadFamilies ? { omitIdleSubagents: true } : {}),
          ...(config.shellOlderSettled ? { omitOlderSettled: true } : {}),
        },
        (event) => {
          if (event.kind !== "snapshot") return;
          resolve(event.snapshot);
        },
        reject,
      );
    });
    return { environmentId, config, shell };
  } finally {
    stop?.();
  }
}

import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export function threadProjectGroups(threads: readonly OrchestrationV2ThreadShell[]) {
  const groups = new Map<
    string,
    { key: string; projectId: string; pinned: boolean; threads: OrchestrationV2ThreadShell[] }
  >();
  for (const thread of threads) {
    const pinned = thread.pinnedAt != null;
    const key = JSON.stringify([pinned, thread.projectId]);
    let group = groups.get(key);
    if (!group) {
      group = { key, projectId: thread.projectId, pinned, threads: [] };
      groups.set(key, group);
    }
    group.threads.push(thread);
  }
  return [...groups.values()];
}

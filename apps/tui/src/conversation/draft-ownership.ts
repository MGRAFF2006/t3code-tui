import type { TuiClient } from "../runtime/client.ts";
import type { PendingSend } from "../runtime/send-outbox.ts";
import { draftStore } from "./draft-storage.ts";
import { settleSentDraft, type Draft } from "./draft.ts";

export const drafts = new Map<string, Draft>();
export const draftOwners = new Map<
  string,
  {
    apply: (draft: Draft, persist?: boolean) => void;
    settled: () => void;
    invalidate: () => void;
  }
>();

export async function settleRecoveredSend(
  client: Pick<TuiClient, "localStateDirectory">,
  entry: PendingSend,
) {
  if (!entry.composerDraft) return false;
  const scope = `${entry.environmentId}/${entry.threadId}`;
  const current = drafts.get(scope);
  if (current && JSON.stringify(current) !== JSON.stringify(entry.composerDraft)) return false;
  if (current) {
    const next =
      draftStore(client.localStateDirectory, () => {}).get(scope) ??
      settleSentDraft(current, entry.composerDraft);
    drafts.set(scope, next);
    draftOwners.get(scope)?.apply(next, false);
  }
  return true;
}

export async function clearConversationDraft(
  client: Pick<TuiClient, "localStateDirectory">,
  scope: string,
) {
  draftOwners.get(scope)?.invalidate();
  drafts.delete(scope);
  await draftStore(client.localStateDirectory, () => {}).clear(scope);
}

export function createDraftOwnership(
  scope: string,
  persistence: ReturnType<typeof draftStore>,
  initial: Draft,
) {
  let valid = true;
  let saved = initial;
  return {
    update: (value: Draft, persist = true) => {
      if (!valid) return;
      saved = value;
      drafts.set(scope, value);
      if (persist) persistence.save(scope, value);
    },
    changed: (value: Draft) => valid && JSON.stringify(value) !== JSON.stringify(saved),
    invalidate: () => {
      valid = false;
      drafts.delete(scope);
    },
  };
}

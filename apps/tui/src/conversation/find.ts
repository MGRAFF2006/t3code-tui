import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  ThreadId,
} from "@t3tools/contracts";

export interface ConversationFindState {
  readonly open: boolean;
  readonly query: string;
  readonly result: OrchestrationV2SearchThreadResult | null;
  readonly searching: boolean;
  readonly error: string | null;
}

export const CLOSED_CONVERSATION_FIND: ConversationFindState = {
  open: false,
  query: "",
  result: null,
  searching: false,
  error: null,
};

export function createConversationFind(options: {
  threadId: ThreadId;
  current: () => boolean;
  subscribe: (
    input: OrchestrationV2SearchThreadInput,
    onValue: (value: OrchestrationV2SearchThreadResult) => void,
    onError: (error: Error) => void,
  ) => () => void;
  onChange: (state: ConversationFindState) => void;
  reveal: (
    match: NonNullable<OrchestrationV2SearchThreadResult["match"]>,
    current: () => boolean,
  ) => Promise<void>;
}) {
  let state = CLOSED_CONVERSATION_FIND;
  let generation = 0;
  let disposed = false;
  let stop: (() => void) | undefined;
  let refreshTimer: Fiber.Fiber<void> | undefined;
  let refreshPending = false;
  const publish = (patch: Partial<ConversationFindState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const current = () => !disposed && options.current();
  function cancelRefresh() {
    if (refreshTimer !== undefined) Effect.runFork(Fiber.interrupt(refreshTimer));
    refreshTimer = undefined;
    refreshPending = false;
  }
  function search(input: Pick<OrchestrationV2SearchThreadInput, "index" | "start" | "offset">) {
    const requestGeneration = ++generation;
    stop?.();
    stop = undefined;
    if (!current()) return;
    publish({ searching: true, error: null });
    const active = () => current() && state.open && generation === requestGeneration;
    let revealed: string | undefined;
    const failed = (error: Error) => {
      if (!active()) return;
      publish({ searching: false, error: error.message });
    };
    try {
      const cancel = options.subscribe(
        { threadId: options.threadId, query: state.query, ...input },
        (result) => {
          if (!active()) return;
          publish({ result, searching: result.complete === false });
          const match = result.match;
          const key = match ? `${match.entryId}/${match.occurrence}` : undefined;
          if (match && revealed !== key) {
            revealed = key;
            void options.reveal(match, active).catch(failed);
          }
          if (result.complete !== false && refreshPending) scheduleRefresh();
        },
        failed,
      );
      if (active()) stop = cancel;
      else cancel();
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
    }
  }
  function refresh() {
    if (!current() || !state.open) return;
    if (state.searching) {
      refreshPending = true;
      return;
    }
    refreshPending = false;
    const match = state.result?.match;
    search(match ? { start: { entryId: match.entryId, occurrence: match.occurrence } } : {});
  }
  function scheduleRefresh() {
    if (!current() || !state.open || refreshTimer !== undefined) return;
    refreshPending = true;
    refreshTimer = Effect.runFork(
      Effect.sleep("300 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            refreshTimer = undefined;
            refresh();
          }),
        ),
      ),
    );
  }
  function close() {
    generation += 1;
    stop?.();
    stop = undefined;
    cancelRefresh();
    publish({ open: false, result: null, searching: false, error: null });
  }
  return {
    open(query: string, entryId?: string) {
      if (!current()) throw new Error("Return to this conversation to search it.");
      const value = query.trim();
      if (!value || value.length > 200)
        throw new Error("Enter a search phrase of at most 200 characters.");
      cancelRefresh();
      publish({ open: true, query: value, result: null });
      search(entryId ? { start: { entryId, occurrence: 0 } } : {});
    },
    step(delta: number) {
      const result = state.result;
      if (!state.open || state.searching || !result?.totalMatches || !current()) return;
      cancelRefresh();
      const match = result.match;
      search(
        match
          ? { start: { entryId: match.entryId, occurrence: match.occurrence }, offset: delta }
          : { index: (result.activeIndex + delta + result.totalMatches) % result.totalMatches },
      );
    },
    changed: scheduleRefresh,
    retry() {
      cancelRefresh();
      refresh();
    },
    close,
    dispose() {
      disposed = true;
      generation += 1;
      stop?.();
      stop = undefined;
      cancelRefresh();
    },
  };
}

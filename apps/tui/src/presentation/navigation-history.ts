import type { Area } from "../ui/controller.ts";

export interface NavigationEntry {
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly area: Area;
}

const sameEntry = (left: NavigationEntry | undefined, right: NavigationEntry) =>
  left?.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.area === right.area;

export function createNavigationHistory() {
  let entries: NavigationEntry[] = [];
  let index = -1;
  return {
    record(entry: NavigationEntry) {
      if (sameEntry(entries[index], entry)) return false;
      entries = [...entries.slice(0, index + 1), entry].slice(-200);
      index = entries.length - 1;
      return true;
    },
    target(direction: "back" | "forward") {
      const next = index + (direction === "back" ? -1 : 1);
      const entry = entries[next];
      return entry ? { entry, index: next } : null;
    },
    visit(target: { entry: NavigationEntry; index: number }) {
      if (!sameEntry(entries[target.index], target.entry)) return false;
      index = target.index;
      return true;
    },
  };
}

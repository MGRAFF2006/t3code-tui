import { SelectRenderable, type MouseEvent } from "@opentui/core";

export function selectOptionAtPointer(event: MouseEvent) {
  const list = event.currentTarget;
  if (!(list instanceof SelectRenderable) || event.button !== 0) return;
  const row = event.y - list.y;
  if (row < 0 || row >= list.height) return;
  // OpenTUI 0.8.4 centres its text-only lists but provides no pointer selection handler.
  const lines = list.showDescription ? 2 : 1;
  const visible = Math.max(1, Math.floor(list.height / lines));
  if (row >= visible * lines) return;
  const start = Math.max(
    0,
    Math.min(list.getSelectedIndex() - Math.floor(visible / 2), list.options.length - visible),
  );
  const index = start + Math.floor(row / lines);
  if (index < list.options.length) list.setSelectedIndex(index);
}

export function scrollSelectOptions(event: MouseEvent) {
  const list = event.currentTarget;
  if (!(list instanceof SelectRenderable) || !event.scroll) return;
  const steps = Math.max(1, Math.floor(Math.abs(event.scroll.delta)));
  if (event.scroll.direction === "up") list.moveUp(steps);
  else if (event.scroll.direction === "down") list.moveDown(steps);
}

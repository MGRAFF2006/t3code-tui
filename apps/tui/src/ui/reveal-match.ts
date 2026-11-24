import { createEffect, onCleanup } from "solid-js";
import {
  TextBuffer,
  type CliRenderer,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";

function revealTextMatch(
  box: ScrollBoxRenderable | undefined,
  node: TextRenderable,
  offset: number,
  renderer: Pick<CliRenderer, "widthMethod" | "nativeScene">,
  current: () => boolean,
) {
  box?.afterLayout(() => {
    if (!current() || box.isDestroyed || node.isDestroyed) return;
    const measure = TextBuffer.create(renderer.widthMethod, renderer.nativeScene);
    let column: number;
    try {
      measure.setText(node.plainText.slice(0, offset));
      column = measure.length;
    } finally {
      measure.destroy();
    }
    const lines = node.lineInfo;
    let line = 0;
    for (let index = 0; index < lines.lineSources.length; index += 1)
      if (lines.lineStartCols[index]! <= column) line = index;
    const y = node.y + line;
    const x = node.x + column - (lines.lineStartCols[line] ?? 0);
    const top = box.viewport.y;
    const left = box.viewport.x;
    box.scrollTo({
      y:
        y < top + 1 || y >= top + box.viewport.height - 1
          ? box.scrollTop + y - top - 1
          : box.scrollTop,
      x: x < left || x >= left + box.viewport.width ? box.scrollLeft + x - left : box.scrollLeft,
    });
  });
}

export function createTextMatchRevealer(
  renderer: Pick<CliRenderer, "widthMethod" | "nativeScene">,
  scroll: () => ScrollBoxRenderable | undefined,
  enabled: () => boolean,
) {
  let anchor:
    | { box: ScrollBoxRenderable; node: TextRenderable; offset: number; current: () => boolean }
    | undefined;
  let detach: (() => void) | undefined;
  function clear() {
    detach?.();
    detach = undefined;
    anchor = undefined;
  }
  const reveal = () => {
    const captured = anchor;
    if (!captured) return;
    revealTextMatch(
      captured.box,
      captured.node,
      captured.offset,
      renderer,
      () => anchor === captured && enabled() && captured.current() && scroll() === captured.box,
    );
  };
  // Active find follows native viewport and text reflow; closed find owns no listeners.
  createEffect(() => {
    if (!enabled()) clear();
  });
  onCleanup(clear);
  return (node: TextRenderable, offset: number, current: () => boolean = () => true) => {
    const box = scroll();
    if (!box || !enabled()) return;
    if (anchor?.box !== box || anchor.node !== node) {
      clear();
      box.viewport.on("resize", reveal);
      node.on("line-info-change", reveal);
      detach = () => {
        box.viewport.off("resize", reveal);
        node.off("line-info-change", reveal);
      };
    }
    anchor = { box, node, offset, current };
    reveal();
  };
}

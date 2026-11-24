import {
  TextBuffer,
  type CliRenderer,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";

export function revealTextMatch(
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

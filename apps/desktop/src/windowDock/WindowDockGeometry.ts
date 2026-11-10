import type { ScreenRect } from "./WindowDockProtocol.ts";

/**
 * Electron reports window bounds in DIPs, which on macOS are the points the Accessibility API
 * uses, both with a top-left origin. The renderer's panel rect is in CSS px of the window
 * content, which webContents zoom scales to DIPs. Display scale never enters.
 */
export function panelToScreenFrame(input: {
  readonly panel: ScreenRect;
  readonly contentBounds: ScreenRect;
  readonly zoomFactor: number;
}): ScreenRect | null {
  const zoom = Number.isFinite(input.zoomFactor) && input.zoomFactor > 0 ? input.zoomFactor : 1;
  const x = Math.round(input.contentBounds.x + input.panel.x * zoom);
  const y = Math.round(input.contentBounds.y + input.panel.y * zoom);
  const width = Math.round(input.panel.width * zoom);
  const height = Math.round(input.panel.height * zoom);
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

export const sameFrame = (a: ScreenRect | null, b: ScreenRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

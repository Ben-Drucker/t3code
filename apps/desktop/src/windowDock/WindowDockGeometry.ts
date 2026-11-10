import type { ScreenRect } from "./WindowDockProtocol.ts";

/**
 * Electron reports window bounds in DIPs, which on macOS are the points the Accessibility API
 * uses, both with a top-left origin. The renderer's panel rect is in CSS px, which webContents
 * zoom scales to DIPs. Display scale never enters.
 */
export const panelWidthToDips = (panelWidth: number, zoomFactor: number) => {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(panelWidth * zoom);
};

/** Chrome fills the strip the T3 window gave up, level with it and as tall. */
export const sideFrame = (window: ScreenRect, width: number): ScreenRect => ({
  x: window.x + window.width,
  y: window.y,
  width,
  height: window.height,
});

export const sameFrame = (a: ScreenRect | null, b: ScreenRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

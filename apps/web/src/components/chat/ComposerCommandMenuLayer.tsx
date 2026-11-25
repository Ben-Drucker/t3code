import { type ReactNode, useDeferredValue, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

/** Mounts the layer one deferred render after `open` turns true, so the keystroke that opened it paints first. */
export function DeferredComposerCommandMenuLayer({
  open,
  ...props
}: Parameters<typeof ComposerCommandMenuLayer>[0] & { open: boolean }) {
  const mounted = useDeferredValue(open, false);
  return open && mounted ? <ComposerCommandMenuLayer {...props} /> : null;
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  onReadCaretPosition?: (() => { left: number; top: number } | null) | undefined;
  compact?: boolean;
  children: ReactNode;
  /** Keeps the 96px floor past the window top: the stash then loses its header, not its entries. */
  canOverflowTop?: boolean;
}) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);
  const { anchor, compact, onReadCaretPosition, canOverflowTop = false } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the menu from the composer's DOM rect, tracking window resize, scroll and ancestor resizes
  useLayoutEffect(() => {
    if (!anchor) return;

    const updatePosition = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
      const mainSurface = form?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
      const rootFontSizePx =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const drawerInsetRem = Number.parseFloat(
        window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
      );
      const drawerInset = drawerInsetRem * rootFontSizePx;
      if (compact) {
        const compactWidth = Math.min(248, Math.max(176, rect.width - drawerInset * 2));
        if (compactWidth <= 0) {
          setPosition(null);
          return;
        }
        const caretPosition = onReadCaretPosition?.() ?? null;
        const anchorTop = caretPosition?.top ?? rect.top;
        const rawLeft = caretPosition !== null ? caretPosition.left - 12 : rect.left + drawerInset;
        const minLeft = Math.max(8, rect.left);
        const maxLeft = Math.max(
          minLeft,
          Math.min(window.innerWidth - compactWidth - 8, rect.right - compactWidth),
        );
        const next = {
          bottom: Math.max(8, window.innerHeight - anchorTop + 6),
          left: Math.min(maxLeft, Math.max(minLeft, rawLeft)),
          maxHeight: Math.max(96, anchorTop - 16),
          width: compactWidth,
        };
        setPosition((current) =>
          current && composerCommandMenuPositionsEqual(current, next) ? current : next,
        );
        return;
      }
      const width = rect.width - drawerInset * 2;
      if (width <= 0) {
        setPosition(null);
        return;
      }
      const composerOverlap = rootFontSizePx + 1;
      const spaceAbove = rect.top + composerOverlap;
      const bottom = window.innerHeight - spaceAbove;
      const floorHeight = Math.max(96, spaceAbove - 24);
      const maxHeight = canOverflowTop ? floorHeight : Math.min(floorHeight, window.innerHeight);
      const next = {
        // With too little room above, the menu slides down over the composer instead of past the window top.
        bottom: canOverflowTop ? bottom : Math.min(bottom, window.innerHeight - maxHeight),
        left: rect.left + drawerInset,
        maxHeight,
        width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);

    return () => {
      stopObserving();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchor, compact, onReadCaretPosition, canOverflowTop]);

  if (!anchor || !position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
      data-composer-drawer-compact={props.compact ? "true" : undefined}
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

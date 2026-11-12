import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  resolveTimelineMinimapAutoScrollTop,
  resolveTimelineMinimapEdgeFade,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapItemOffset,
  resolveTimelineMinimapMaskImage,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTrackHeight,
  TIMELINE_MINIMAP_MIN_ITEMS,
  TIMELINE_MINIMAP_TRACK_PADDING_Y,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

interface RailScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

function readRailScrollMetrics(node: HTMLElement): RailScrollMetrics {
  return {
    scrollTop: node.scrollTop,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  };
}

export function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  atEnd,
  items,
  stripMap,
  onWheel,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex: number | null;
  atEnd: boolean;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onWheel: (event: WheelEvent) => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState<RailScrollMetrics>({
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  });
  const railNodeRef = useRef<HTMLButtonElement | null>(null);
  const pointerClientYRef = useRef<number | null>(null);

  const syncScrollMetrics = (node: HTMLElement) => {
    const next = readRailScrollMetrics(node);
    setScrollMetrics((current) =>
      current.scrollTop === next.scrollTop &&
      current.clientHeight === next.clientHeight &&
      current.scrollHeight === next.scrollHeight
        ? current
        : next,
    );
  };

  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    const handleWheel = (event: WheelEvent) => {
      const rail = railNodeRef.current;
      if (
        rail &&
        event.target instanceof Node &&
        rail.contains(event.target) &&
        rail.scrollHeight > rail.clientHeight + 1
      ) {
        return;
      }
      onWheel(event);
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  };

  const railRef = (node: HTMLButtonElement | null) => {
    railNodeRef.current = node;
    if (!node) return;
    syncScrollMetrics(node);
    const track = node.firstElementChild;
    return observeResize(track ? [node, track] : node, () => syncScrollMetrics(node));
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolveTimelineMinimapPreview(
    resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
  );
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const trackHeight = resolveTimelineMinimapTrackHeight(items.length);
  const viewportHeight = scrollMetrics.clientHeight > 0 ? scrollMetrics.clientHeight : trackHeight;
  const activeVisualTopPx =
    resolvedActiveIndex === null
      ? 0
      : Math.max(
          0,
          Math.min(
            viewportHeight,
            resolveTimelineMinimapItemOffset(resolvedActiveIndex) - scrollMetrics.scrollTop,
          ),
        );
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem =
    resolvedCurrentIndex === null || atEnd ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const scrollIndexIntoView = (targetIndex: number | null) => {
    const node = railNodeRef.current;
    if (!node || targetIndex === null) return;
    const nextScrollTop = resolveTimelineMinimapAutoScrollTop({
      targetIndex,
      itemCount: items.length,
      scrollTop: node.scrollTop,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    });
    if (nextScrollTop !== null) {
      node.scrollTop = nextScrollTop;
    }
    syncScrollMetrics(node);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the rail DOM node to keep the active turn in view and reads back its post-layout scroll metrics
  useLayoutEffect(() => {
    const node = railNodeRef.current;
    if (!node) return;
    if (pointerClientYRef.current === null) {
      const nextScrollTop = resolveTimelineMinimapAutoScrollTop({
        targetIndex: resolvedCurrentIndex,
        itemCount: items.length,
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      });
      if (nextScrollTop !== null) {
        node.scrollTop = nextScrollTop;
      }
    }
    const next = readRailScrollMetrics(node);
    setScrollMetrics((current) =>
      current.scrollTop === next.scrollTop &&
      current.clientHeight === next.clientHeight &&
      current.scrollHeight === next.scrollHeight
        ? current
        : next,
    );
  }, [resolvedCurrentIndex, items.length]);

  const resolveActiveIndexFromElementAndPointer = (element: HTMLElement, clientY: number) => {
    const rect = element.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      scrollTop: element.scrollTop,
      pointerY: clientY,
    });
  };

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) =>
    resolveActiveIndexFromElementAndPointer(event.currentTarget, event.clientY);

  const updateActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    pointerClientYRef.current = event.clientY;
    const nextIndex = resolveActiveIndexFromPointer(event);
    setActiveIndex(nextIndex);
  };

  const focusActiveIndex = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, nextIndex));
    setActiveIndex(clamped);
    scrollIndexIntoView(clamped);
  };

  const moveActiveIndex = (delta: number) => {
    const base = resolvedActiveIndex ?? resolvedCurrentIndex ?? 0;
    focusActiveIndex(base + delta);
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const edgeFade = resolveTimelineMinimapEdgeFade(scrollMetrics);
  const maskImage = resolveTimelineMinimapMaskImage(edgeFade);
  const spineHeight = Math.max(0, trackHeight - TIMELINE_MINIMAP_TRACK_PADDING_Y * 2);

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 w-18",
        hasPersistentGutter
          ? "opacity-100"
          : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseLeave={() => {
            pointerClientYRef.current = null;
            setActiveIndex(null);
          }}
          onMouseMove={(event) => {
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return;
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: hitStripWidth,
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer overflow-y-auto overflow-x-hidden overscroll-y-contain bg-transparent [-ms-overflow-style:none] [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:hidden"
            data-fade-bottom={edgeFade.fadeBottom ? "true" : "false"}
            data-fade-top={edgeFade.fadeTop ? "true" : "false"}
            onBlur={() => {
              if (pointerClientYRef.current === null) {
                setActiveIndex(null);
              }
            }}
            onClick={(event) => {
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              updateActiveIndexFromPointer(event);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onScroll={(event) => {
              const element = event.currentTarget;
              syncScrollMetrics(element);
              if (pointerClientYRef.current !== null) {
                setActiveIndex(
                  resolveActiveIndexFromElementAndPointer(element, pointerClientYRef.current),
                );
              }
            }}
            ref={railRef}
            style={
              maskImage
                ? {
                    maskImage,
                    WebkitMaskImage: maskImage,
                  }
                : undefined
            }
            type="button"
          >
            <span className="relative block w-full" style={{ height: `${trackHeight}px` }}>
              <span
                className="pointer-events-none absolute left-3 w-px bg-border/15"
                style={{
                  top: `${TIMELINE_MINIMAP_TRACK_PADDING_Y}px`,
                  height: `${spineHeight}px`,
                }}
              />
              {items.map((item, index) => {
                const top = `${resolveTimelineMinimapItemOffset(index)}px`;
                const activeDistance =
                  resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
                return (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:bg-foreground/55 after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100",
                      activeDistance === 0 ? "bg-muted-foreground/60" : "bg-muted-foreground/25",
                      activeDistance === 0
                        ? "scale-x-100"
                        : activeDistance === 1
                          ? "scale-x-[0.667]"
                          : activeDistance === 2
                            ? "scale-x-[0.417]"
                            : "scale-x-[0.333]",
                    )}
                    data-in-view="false"
                    data-minimap-strip
                    key={item.id}
                    ref={(node) => {
                      if (node) {
                        stripMap.set(item.id, node);
                      } else {
                        stripMap.delete(item.id);
                      }
                    }}
                    style={{ top }}
                  />
                );
              })}
            </span>
          </button>
          {activeItem ? (
            // Display-only: it overlaps the message column, and the strip keeps tracking beneath it.
            <span
              className="pointer-events-none absolute left-8 z-20 w-80 -translate-y-1/2"
              data-minimap-preview
              style={{ top: `${activeVisualTopPx}px` }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}

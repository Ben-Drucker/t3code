import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import {
  resolveSidebarThreadStatus,
  rollUpSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

const CHILD_INDENT_REM = 0.875;
// Where the first connector line runs, under the parent row's leading icon.
const CONNECTOR_START_REM = 1.125;
// One opaque color, so segments that meet or overlap cannot darken each other.
const CONNECTOR_CLASS = "pointer-events-none absolute border-(--sidebar-tree-line)";
// Reaches across the 1px gap between sibling rows, so a trunk runs unbroken from row to row.
const TRUNK_CLASS = `${CONNECTOR_CLASS} top-0 -bottom-px border-s`;
const BRANCH_WIDTH_REM = CHILD_INDENT_REM - 0.125;

/**
 * The tree lines beside a nested row: ancestor trunks, this level's trunk when siblings follow,
 * and the branch into the row. The last sibling is one curved element ending at the row's midline.
 * Lengths are whole pixels at the default font size so edges stay crisp at fractional DPRs.
 */
function SidebarChildConnectors(props: {
  depth: number;
  isLast: boolean;
  continuingLevels: readonly boolean[];
}) {
  const columnX = (level: number) => `${CONNECTOR_START_REM + (level - 1) * CHILD_INDENT_REM}rem`;
  return (
    <>
      {props.continuingLevels.flatMap((continues, index) =>
        continues
          ? [
              <span
                key={`level-${index + 1}`}
                aria-hidden
                className={TRUNK_CLASS}
                style={{ insetInlineStart: columnX(index + 1) }}
              />,
            ]
          : [],
      )}
      {props.isLast ? (
        <span
          aria-hidden
          className={cn(CONNECTOR_CLASS, "top-0 h-1/2 rounded-es-md border-s border-b")}
          style={{ insetInlineStart: columnX(props.depth), width: `${BRANCH_WIDTH_REM}rem` }}
        />
      ) : (
        <>
          <span
            aria-hidden
            className={TRUNK_CLASS}
            style={{ insetInlineStart: columnX(props.depth) }}
          />
          <span
            aria-hidden
            className={cn(CONNECTOR_CLASS, "top-0 h-1/2 border-b")}
            style={{ insetInlineStart: columnX(props.depth), width: `${BRANCH_WIDTH_REM}rem` }}
          />
        </>
      )}
    </>
  );
}

/** The chevron that folds a row's nested children; shared by top-level and child rows. */
export function SidebarChildToggle(props: {
  expanded: boolean;
  threadKey: string;
  onToggle: (threadKey: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.expanded ? "Collapse subagents" : "Expand subagents"}
      aria-expanded={props.expanded}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onToggle(props.threadKey);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 transition-transform motion-reduce:transition-none",
          props.expanded && "rotate-90",
        )}
      />
    </button>
  );
}

const STATUS_GLYPHS: Partial<
  Record<SidebarThreadStatus, { label: string; Icon: typeof CircleDashedIcon; className: string }>
> = {
  preparing: { label: "Setting up", Icon: CircleDashedIcon, className: "text-info-foreground" },
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info-foreground" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error-foreground" },
  limited: { label: "Limited", Icon: CircleAlertIcon, className: "text-warning-foreground" },
};

/** A subagent or side chat nested under its parent row: open and fold only. */
export const SidebarChildThreadRow = memo(function SidebarChildThreadRow(props: {
  thread: SidebarThreadSummary;
  depth: number;
  isLast: boolean;
  continuingLevels: readonly boolean[];
  // Null when the row has no children of its own.
  expanded: boolean | null;
  descendantStatus: SidebarThreadStatus | null;
  isActive: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
  onToggle: (threadKey: string) => void;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const thread = useThreadShell(threadRef) ?? props.thread;
  const status = rollUpSidebarThreadStatus(
    resolveSidebarThreadStatus(thread),
    props.descendantStatus === null ? [] : [props.descendantStatus],
  );
  const glyph = STATUS_GLYPHS[status];
  const activate = () => props.onActivate(threadRef);
  return (
    <li
      className="relative list-none"
      style={{ paddingInlineStart: `${props.depth * CHILD_INDENT_REM}rem` }}
    >
      <SidebarChildConnectors
        depth={props.depth}
        isLast={props.isLast}
        continuingLevels={props.continuingLevels}
      />
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-row-child"
        aria-label={[thread.title, glyph?.label].filter(Boolean).join(", ")}
        aria-current={props.isActive ? "page" : undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          activate();
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        {props.expanded === null ? (
          <span aria-hidden className="size-4 shrink-0" />
        ) : (
          <SidebarChildToggle
            expanded={props.expanded}
            threadKey={threadKey}
            onToggle={props.onToggle}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {glyph ? (
          <glyph.Icon aria-hidden className={cn("size-3.5 shrink-0", glyph.className)} />
        ) : null}
      </div>
    </li>
  );
});

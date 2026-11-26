import type { EnvironmentId, PiToolChoices, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { composerToolsEnvironment } from "~/state/composerTools";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentToolSourceIcon } from "./AgentConfigChip";
import { ComposerControl } from "./ComposerControl";
import {
  buildPiToolTree,
  isPiToolDeferred,
  piToolsDeferredState,
  piToolsUnder,
  withPiToolsDeferred,
  type PiToolNode,
} from "./PiToolsMenu.logic";

/** Chooses which of a Pi thread's tools load up front and which wait for tool_search. */
export const PiToolsMenu = memo(function PiToolsMenu(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const label = gt("Pi tools: loaded up front or deferred");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size="xs"
                  aria-label={label}
                  data-testid="composer-pi-tools-button"
                  className="px-1.5"
                />
              }
            />
          }
        >
          <WrenchIcon aria-hidden="true" className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="end" width="lg" padding="none">
        {open ? (
          <PiToolsPanel environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});

function PiToolsPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    composerToolsEnvironment.piTools({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const save = useAtomCommand(composerToolsEnvironment.setPiToolChoices, {
    label: gt("Save Pi tool choices"),
  });
  const [edited, setEdited] = useState<PiToolChoices | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["T3"]));
  const [acknowledged, setAcknowledged] = useState(false);
  const tools = query.data?.tools ?? [];
  const choices = edited ?? query.data?.choices ?? {};
  const tree = buildPiToolTree(tools);

  const change = (next: PiToolChoices) => {
    setEdited(next);
    void save({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, choices: next },
    });
  };
  const toggleFolder = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (query.data !== null && query.data !== undefined && tools.length === 0) {
    return (
      <p className="px-3 py-3 text-secondary-label text-xs">{gt("No tools to choose from.")}</p>
    );
  }
  const all = piToolsDeferredState(tools, choices);
  const locked = query.data?.started === true && !acknowledged;
  return (
    <div className="relative flex max-h-96 flex-col">
      {locked ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80 px-6 text-center backdrop-blur-xs">
          <p className="text-xs">
            {gt(
              "This thread has already started. Changing its tools can make the next message reprocess the whole conversation, at full price, for models that cannot take the change mid-conversation.",
            )}
          </p>
          <Button size="xs" variant="outline" onClick={() => setAcknowledged(true)}>
            {gt("Change tools anyway")}
          </Button>
        </div>
      ) : null}
      <div
        className={cn("flex min-h-0 flex-1 flex-col", locked && "pointer-events-none opacity-40")}
        aria-hidden={locked}
        inert={locked}
      >
        <label className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
          <Checkbox
            checked={all === "all"}
            indeterminate={all === "some"}
            onCheckedChange={(checked) => change(withPiToolsDeferred(choices, tools, checked))}
          />
          <span className="flex-1">{gt("Defer all")}</span>
          <span className="text-secondary-label font-normal">
            {gt("Applies from the next message")}
          </span>
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {tree.map((node) => (
            <PiToolRow
              key={node.id}
              node={node}
              depth={0}
              choices={choices}
              expanded={expanded}
              onToggleFolder={toggleFolder}
              onChange={change}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PiToolRow(props: {
  node: PiToolNode;
  depth: number;
  choices: PiToolChoices;
  expanded: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onChange: (next: PiToolChoices) => void;
}) {
  const gt = useGT();
  const { node } = props;
  const tools = piToolsUnder(node);
  const state = piToolsDeferredState(tools, props.choices);
  const deferrable = tools.some((tool) => tool.deferrable);
  const isOpen = props.expanded.has(node.id);
  const indent = { paddingInlineStart: `${0.75 + props.depth * 1}rem` };
  const checkbox = (
    <Checkbox
      aria-label={node.tool === null ? gt("Defer all in {name}", { name: node.label }) : node.label}
      checked={state === "all"}
      indeterminate={state === "some"}
      disabled={!deferrable}
      onCheckedChange={(checked) =>
        props.onChange(withPiToolsDeferred(props.choices, tools, checked))
      }
    />
  );
  if (node.tool !== null) {
    const tool = node.tool;
    return (
      <label
        className="flex min-h-7 items-center gap-2 pe-3 text-xs hover:bg-accent/50"
        style={indent}
      >
        {checkbox}
        <span className="shrink-0 font-medium">{node.label}</span>
        <span className="min-w-0 flex-1 truncate text-secondary-label">{tool.description}</span>
        {!tool.deferrable ? (
          <Badge size="sm" variant="outline">
            {gt("always")}
          </Badge>
        ) : isPiToolDeferred(tool, props.choices) ? (
          <Badge size="sm" variant="outline">
            {gt("deferred")}
          </Badge>
        ) : null}
      </label>
    );
  }
  return (
    <>
      <div
        className="flex min-h-7 items-center gap-2 pe-3 text-xs hover:bg-accent/50"
        style={indent}
      >
        {checkbox}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium"
          aria-expanded={isOpen}
          onClick={() => props.onToggleFolder(node.id)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-secondary-label transition-transform motion-reduce:transition-none",
              isOpen && "rotate-90",
            )}
          />
          {props.depth === 0 ? (
            <AgentToolSourceIcon source={node.label} className="size-3.5 shrink-0" />
          ) : null}
          <span className="truncate">{node.label}</span>
          <Badge className="ms-auto" size="sm" variant="secondary">
            {tools.length}
          </Badge>
        </button>
      </div>
      {isOpen
        ? node.children.map((child) => (
            <PiToolRow key={child.id} {...props} node={child} depth={props.depth + 1} />
          ))
        : null}
    </>
  );
}

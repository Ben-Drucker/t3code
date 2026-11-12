import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectEntry,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ComposerToolGroup,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  ChevronRightIcon,
  FolderIcon,
  MessagesSquareIcon,
  PackageIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useLayoutEffect, useRef, type KeyboardEvent } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { Input } from "../ui/input";
import { AgentToolSourceIcon } from "./AgentConfigChip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerBanner } from "./ComposerBanner";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      searchTarget: ComposerPathSearchTarget;
      /** Set for folders found by typing a disk path: picking one keeps browsing inside it. */
      directoryCompletion?: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      thread: ScopedThreadRef;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "environment";
      environmentId: EnvironmentId;
      machine: EnvironmentMachineKind;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent-model";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent-section";
      source: string;
      kind: ComposerToolGroup["kind"];
      status: ComposerToolGroup["status"];
      toolCount: number;
      expanded: boolean;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent-tool";
      source: string;
      /** Null for a server row with no tool to insert: checking. */
      tool: string | null;
      status: ComposerToolGroup["status"];
      deferred: boolean;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "emoji";
      emoji: string;
      shortcode: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      instanceId: ProviderInstanceId;
      model: string;
      driverKind: ProviderDriverKind;
      providerDisplayName: string;
      acpRegistryAgentId: string | undefined;
      acpRegistryIconUrl: string | undefined;
      label: string;
      description: string;
    };

/** Rows of one tool source, shown under its header while the header is open. */
type MenuBlock =
  | { readonly kind: "item"; readonly item: ComposerCommandItem }
  | {
      readonly kind: "section";
      readonly header: Extract<ComposerCommandItem, { type: "agent-section" }>;
      readonly rows: ComposerCommandItem[];
    };

function menuBlocks(items: ReadonlyArray<ComposerCommandItem>): MenuBlock[] {
  const blocks: MenuBlock[] = [];
  for (const item of items) {
    if (item.type === "agent-section") {
      blocks.push({ kind: "section", header: item, rows: [] });
      continue;
    }
    const last = blocks.at(-1);
    if (item.type === "agent-tool" && last?.kind === "section") {
      last.rows.push(item);
    } else {
      blocks.push({ kind: "item", item });
    }
  }
  return blocks;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  /** The `%` query as the search field shows it; null outside the `%` menu. */
  agentToolQuery: string | null;
  onAgentToolQueryChange: (query: string) => void;
  onAgentToolQueryKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onDismissAgentToolMenu?: (options: { readonly restoreFocus: boolean }) => void;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const onDismissRef = useRef(props.onDismissAgentToolMenu);
  const isAgentToolMenu = props.agentToolQuery !== null;
  const isEmojiMenu = props.triggerKind === "emoji";
  const firstSectionId = props.items.find((item) => item.type === "agent-section")?.id;
  const renderItem = (item: ComposerCommandItem) => (
    <Fragment key={item.id}>
      {item.id === firstSectionId ? <CommandGroupLabel>Tools</CommandGroupLabel> : null}
      {item.type === "agent-model" ? (
        <CommandGroupLabel>Agent configuration</CommandGroupLabel>
      ) : null}
      <ComposerCommandMenuItem
        optionId={composerSuggestionOptionId(props.listId, item.id)}
        item={item}
        triggerKind={props.triggerKind}
        resolvedTheme={props.resolvedTheme}
        isActive={props.activeItemId === item.id}
        onHighlight={props.onHighlightedItemChange}
        onSelect={props.onSelect}
      />
    </Fragment>
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps capture-phase Escape/outside listeners pointed at the latest dismiss callback without re-focusing the search input
  useLayoutEffect(() => {
    onDismissRef.current = props.onDismissAgentToolMenu;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the portaled `%` search input on open and closes on Escape or outside pointerdown
  useLayoutEffect(() => {
    if (!isAgentToolMenu) return;
    searchInputRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onDismissRef.current?.({ restoreFocus: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      const surface = listRef.current;
      if (!surface || event.composedPath().includes(surface)) return;
      onDismissRef.current?.({ restoreFocus: false });
    };

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isAgentToolMenu]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        detached={isEmojiMenu}
        className={cn(
          "flex min-h-0 w-full flex-col overflow-hidden **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4",
          isEmojiMenu ? "pb-0" : "pb-(--chat-composer-attachment-overlap)",
        )}
        data-composer-command-drawer="true"
      >
        {props.agentToolQuery !== null ? (
          <div className="px-3 pt-3">
            <Input
              ref={searchInputRef}
              type="search"
              size="sm"
              aria-label="Search tools"
              placeholder="Search tools"
              autoComplete="off"
              spellCheck={false}
              value={props.agentToolQuery}
              onChange={(event) => props.onAgentToolQueryChange(event.target.value)}
              onKeyDown={props.onAgentToolQueryKeyDown}
            />
          </div>
        ) : null}
        {props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined}
            className={cn("min-h-0 scroll-pb-6", isEmojiMenu ? "max-h-56" : "max-h-72")}
          >
            <CommandGroup>
              {menuBlocks(props.items).map((block) =>
                block.kind === "item" ? (
                  renderItem(block.item)
                ) : (
                  <Collapsible key={block.header.id} open={block.header.expanded}>
                    {renderItem(block.header)}
                    <CollapsiblePanel animate={false}>
                      {block.rows.map(renderItem)}
                    </CollapsiblePanel>
                  </Collapsible>
                ),
              )}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className={cn("px-5 pt-3.5", isEmojiMenu ? "pb-3.5" : "pb-7")}>
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "emoji"
                  ? "Loading emoji..."
                  : props.triggerKind === "skill" || props.triggerKind === "slash-command"
                    ? "Searching workspace skills..."
                    : props.triggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "emoji"
                    ? "No matching emoji."
                    : props.triggerKind === "skill"
                      ? "No skills found. Try / to browse provider commands."
                      : props.triggerKind === "path"
                        ? "No matching files or folders."
                        : "No matching command."))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest) : null;

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "emoji" ? (
        <span aria-hidden="true" className="shrink-0 text-base leading-none">
          {props.item.emoji}
        </span>
      ) : null}
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "thread" ? (
        <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "environment" ? (
        <EnvironmentMachineIcon
          kind={props.item.machine}
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary-label"
        />
      ) : null}
      {props.item.type === "agent-model" ? (
        <SlidersHorizontalIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary-label"
        />
      ) : null}
      {props.item.type === "agent-section" ? (
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-secondary-label transition-transform motion-reduce:transition-none",
            props.item.expanded && "rotate-90",
          )}
        />
      ) : null}
      {props.item.type === "agent-section" ? (
        <AgentToolSourceIcon
          source={props.item.source}
          className="size-4 shrink-0 text-secondary-label"
        />
      ) : null}
      {props.item.type === "agent-tool" && props.item.tool !== null ? (
        <WrenchIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "model" ? (
        <ProviderInstanceIcon
          driverKind={props.item.driverKind}
          displayName={props.item.providerDisplayName}
          acpRegistryAgentId={props.item.acpRegistryAgentId}
          acpRegistryIconUrl={props.item.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
      ) : null}
      {pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn("size-4 shrink-0", pullRequestPresentation.toneClassName)}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            "min-w-0 shrink-0 truncate text-xs font-medium",
            props.item.type === "emoji" ? "max-w-full font-mono" : "max-w-[45%] font-sans",
          )}
        >
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        {props.item.description ? (
          <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
            {props.item.description}
          </span>
        ) : null}
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
        {props.item.type === "agent-section" ? (
          <AgentSectionBadge status={props.item.status} toolCount={props.item.toolCount} />
        ) : null}
        {props.item.type === "agent-tool" && props.item.deferred ? (
          <Badge className="ms-auto" size="sm" variant="outline">
            deferred
          </Badge>
        ) : null}
      </span>
    </CommandItem>
  );
});

const AGENT_SECTION_STATUS_BADGE: Record<Exclude<ComposerToolGroup["status"], "ready">, string> = {
  checking: "checking…",
  down: "unreachable",
  "needs-auth": "needs auth",
};

/** The tool count for a ready source, or the status that replaces it. */
function AgentSectionBadge(props: { status: ComposerToolGroup["status"]; toolCount: number }) {
  if (props.status === "ready") {
    return (
      <Badge className="ms-auto" size="sm" variant="secondary">
        {props.toolCount}
      </Badge>
    );
  }
  return (
    <Badge className="ms-auto" size="sm" variant="outline">
      {AGENT_SECTION_STATUS_BADGE[props.status]}
    </Badge>
  );
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  "agent-config": "Agent configuration",
  emoji: "Emoji",
  path: "Files and folders",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}

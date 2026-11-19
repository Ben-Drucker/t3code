import {
  agentToolSectionId,
  buildAgentToolSections,
} from "@t3tools/client-runtime/agent-tool-menu";
import { createComposerToolsEnvironmentAtoms } from "@t3tools/client-runtime/state/composer-tools";
import { formatAgentConfigChip, formatAgentToolChip } from "@t3tools/shared/composerInlineTokens";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { threadPullRequestKeyOf } from "@t3tools/client-runtime/thread-pull-requests";
import * as Dialog from "../../components/ui/Dialog";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type ComposerEnvironmentCandidate,
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const composerToolsEnvironment = createComposerToolsEnvironmentAtoms(connectionAtomRuntime);
const OPEN_TOOL_SECTIONS: ReadonlyMap<string, boolean> = new Map();

const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = [];
const EMPTY_ENVIRONMENTS: ReadonlyArray<ComposerEnvironmentCandidate> = [];
const NO_LINKED_ENVIRONMENTS: ReadonlyMap<EnvironmentId, string> = new Map();
import { COMPOSER_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { environmentComposerContext, pullRequestComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  setComposerDraftContext,
  useComposerDraftSelection,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  composerDirectoryQuery,
  detectComposerTrigger,
  isFilesystemPathQuery,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import {
  formatComposerModelMention,
  rankComposerModelMentions,
} from "@t3tools/client-runtime/composer-model-mentions";
import { useAtomRefresh } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";

import type { ComposerPickerKey } from "../../native/T3ComposerEditor.types";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
import {
  useComposerPathSearch,
  useComposerPullRequestSearch,
  useThreadSearch,
} from "../../state/queries";
import type { ModelOption } from "../../lib/modelOptions";
import { m, type MessageResolver } from "../../i18n/messages";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

const idleWorkspaceSnapshotRefreshAtom: Atom.Atom<unknown> = Atom.make<void>(undefined).pipe(
  Atom.withLabel("mobile:provider-workspace-snapshot-refresh:idle"),
);

function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/**
 * A caret placed by an insertion (chips, pasted context) wins while the draft
 * still has the text it was placed in. Otherwise the composer's own caret is
 * clamped to the draft, and a caret from another owner starts at the end.
 */
export function resolveComposerMenuSelection(input: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly inserted: ComposerEditorSelection | null;
  readonly local: {
    readonly ownerKey: string | null;
    readonly start: number;
    readonly end: number;
  };
}): ComposerEditorSelection {
  if (input.inserted) return input.inserted;
  if (input.local.ownerKey !== input.ownerKey) return composerSelectionAtEnd(input.draftMessage);
  const length = input.draftMessage.length;
  return { start: Math.min(input.local.start, length), end: Math.min(input.local.end, length) };
}

const PULL_REQUEST_STATE_LABELS = {
  open: msg("open", { $context: "pull request state" }),
  closed: msg("closed", { $context: "pull request state" }),
  merged: msg("merged", { $context: "pull request state" }),
} as const;

export function buildComposerSlashCommandItems(
  input: {
    readonly query: string;
    readonly atMessageStart: boolean;
    readonly hasThread: boolean;
    readonly hasCompactableConversation?: boolean;
    readonly offersUsageLimits?: boolean;
    /** T3's `/clear` replaces the provider's, which would clear a session T3 still treats as live. */
    readonly offersFreshSession?: boolean;
    readonly offersSideChat?: boolean;
    readonly selectedProviderStatus: Pick<ServerProvider, "driver" | "slashCommands"> | null;
  },
  resolve: MessageResolver = m,
): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const items: ComposerCommandItem[] = "model".includes(query)
    ? [
        {
          id: "cmd:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: resolve(msg("Switch model")),
        },
      ]
    : [];

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction, except `/clear`.
  if (!input.atMessageStart) return items;
  if (input.offersSideChat) {
    for (const [command, description] of [
      ["side", resolve(msg("Ask a side question in a new side chat"))],
      ["btw", resolve(msg("Same as /side"))],
    ] as const) {
      if (!command.includes(query)) continue;
      items.push({
        id: `cmd:${command}`,
        type: "slash-command",
        command,
        label: `/${command}`,
        description,
      });
    }
  }
  if (input.offersFreshSession && "clear".includes(query)) {
    items.push({
      id: "cmd:clear",
      type: "slash-command",
      command: "clear",
      label: "/clear",
      description: resolve(msg("Start a fresh session")),
    });
  }
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (!command.name.toLowerCase().includes(query)) continue;
    if (command.name === "clear" && input.offersFreshSession) continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === "codex" &&
      command.name === "feedback"
    ) {
      continue;
    }
    items.push({
      id: `pcmd:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    });
  }
  return items;
}

export function buildComposerModelItems(
  modelOptions: ReadonlyArray<ModelOption>,
  query: string,
  providers: ReadonlyArray<ServerProvider>,
): ComposerCommandItem[] {
  // The picker retains saved selections even when their provider is no longer usable.
  const readyProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.installed &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated" &&
          provider.availability !== "unavailable",
      )
      .map((provider) => provider.instanceId),
  );
  return rankComposerModelMentions(
    modelOptions.filter(
      (option) =>
        readyProviderIds.has(option.selection.instanceId) &&
        !option.isUnavailable &&
        !option.isHidden &&
        !option.isLegacy,
    ),
    query,
    (option) => ({
      name: option.label,
      ...(option.subtitle ? { subProvider: option.subtitle } : {}),
      driverKind: option.providerDriver,
      providerDisplayName: option.providerLabel,
    }),
  ).map((option) => ({
    id: `model:${option.key}`,
    type: "model",
    option,
    label: option.label,
    description: option.subtitle
      ? `${option.providerLabel} · ${option.subtitle}`
      : option.providerLabel,
  }));
}

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd"> &
    Partial<Pick<ComposerTrigger, "kind">>;
  readonly item: ComposerCommandItem;
}): { readonly text: string; readonly cursor: number } {
  const { draftMessage, trigger, item } = input;
  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path, item.kind)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  } else if (item.type === "agent-tool") {
    replacement = `${formatAgentToolChip(item)} `;
  } else if (item.type === "model") {
    const { selection, capabilities } = item.option;
    const reference =
      trigger.kind === "agent-config"
        ? formatAgentConfigChip({
            instanceId: selection.instanceId,
            model: selection.model,
            options:
              buildProviderOptionSelectionsFromDescriptors(
                resolveProviderOptionDescriptors({ capabilities, selections: selection.options }),
              ) ??
              selection.options ??
              [],
          })
        : formatComposerModelMention(selection.instanceId, selection.model);
    replacement = `${reference} `;
  }
  return replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement);
}

export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  threadShells = EMPTY_THREAD_SHELLS,
  environments = EMPTY_ENVIRONMENTS,
  linkedEnvironments = NO_LINKED_ENVIRONMENTS,
  currentThreadId = null,
  projectCwd,
  pullRequestProjectId = null,
  pullRequestRepository = null,
  threadPullRequests,
  selectedProviderStatus,
  hasThread,
  hasCompactableConversation,
  offersUsageLimits = false,
  enabled = true,
  onChangeDraftMessage,
  onUsageLimits,
  onOpenModelPicker,
  onConfigureAgentModel,
  modelOptions,
  modelProviders,
  onFreshSession,
  offersSideChat = false,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments?: ReadonlyArray<ComposerEnvironmentCandidate>;
  /** The machines `environmentId` links to, by name, whose threads the picker also offers. */
  readonly linkedEnvironments?: ReadonlyMap<EnvironmentId, string>;
  readonly currentThreadId?: ThreadId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly threadPullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly hasCompactableConversation: boolean;
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUsageLimits?: () => void;
  /** `/model` opens this picker instead of inserting text. */
  readonly onOpenModelPicker: () => void;
  readonly onConfigureAgentModel?: (trigger: ComposerTrigger, option: ModelOption) => void;
  readonly modelOptions?: ReadonlyArray<ModelOption>;
  readonly modelProviders?: ReadonlyArray<ServerProvider>;
  /** Arms a fresh session for the next message; absent where `/clear` is unavailable. */
  readonly onFreshSession?: () => void;
  readonly offersSideChat?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [localSelection, setLocalSelection] = useState(() => ({
    ownerKey,
    ...composerSelectionAtEnd(draftMessage),
  }));
  const [highlight, setHighlight] = useState<{
    ownerKey: string | null;
    query: string;
    itemId: string;
  } | null>(null);
  const [dismissedPath, setDismissedPath] = useState<{
    ownerKey: string | null;
    position: number;
  } | null>(null);
  const [escapedPercent, setEscapedPercent] = useState<{
    ownerKey: string | null;
    position: number;
  } | null>(null);
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const insertedSelection = useComposerDraftSelection(ownerKey, draftMessage);
  const selection = resolveComposerMenuSelection({
    draftMessage,
    ownerKey,
    inserted: insertedSelection,
    local: localSelection,
  });
  const setSelection = (next: ComposerEditorSelection) =>
    setLocalSelection({ ownerKey, start: next.start, end: next.end });

  const skills = selectedProviderStatus
    ? resolveProviderSkillsForCwd(selectedProviderStatus, projectCwd)
    : [];
  const selectedProviderInstanceId = selectedProviderStatus?.instanceId;
  const refreshWorkspaceSnapshot = useAtomRefresh(
    environmentId && projectCwd && selectedProviderInstanceId
      ? providerWorkspaceSnapshotRefresh({
          environmentId,
          instanceId: selectedProviderInstanceId,
          cwd: projectCwd,
        })
      : idleWorkspaceSnapshotRefreshAtom,
  );
  // Every draft change rechecks a stale snapshot, including drafts written by
  // another surface (a prompt link) that never move the editor selection.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the provider workspace snapshot atom whenever the draft text changes from any surface
  useEffect(() => {
    refreshWorkspaceSnapshot();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Draft changes are the recheck signal.
    draftMessage,
    refreshWorkspaceSnapshot,
  ]);
  const onSelectionChange = (nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  };

  const detectedTrigger = (() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end, undefined, true);
  })();
  const triggerSuppressed =
    detectedTrigger?.kind === "agent-config" &&
    escapedPercent?.ownerKey === ownerKey &&
    detectedTrigger.rangeStart === escapedPercent.position;
  const pathDismissed =
    detectedTrigger?.kind === "path" &&
    dismissedPath?.ownerKey === ownerKey &&
    detectedTrigger.rangeStart === dismissedPath.position;
  const trigger = triggerSuppressed || pathDismissed ? null : detectedTrigger;
  const onDraftChange = (text: string) => {
    if (
      detectedTrigger?.kind === "agent-config" &&
      detectedTrigger.query === "" &&
      !triggerSuppressed &&
      text ===
        replaceTextRange(draftMessage, detectedTrigger.rangeEnd, detectedTrigger.rangeEnd, "%").text
    ) {
      setEscapedPercent({ ownerKey, position: detectedTrigger.rangeStart });
      setSelection({ start: detectedTrigger.rangeEnd, end: detectedTrigger.rangeEnd });
      return "restore" as const;
    }
    if (escapedPercent?.ownerKey === ownerKey && text[escapedPercent.position] !== "%")
      setEscapedPercent(null);
    if (dismissedPath?.ownerKey === ownerKey && text[dismissedPath.position] !== "@")
      setDismissedPath(null);
    onChangeDraftMessage(text);
  };
  const toolQuery = useEnvironmentQuery(
    trigger?.kind === "agent-config" && environmentId !== null
      ? composerToolsEnvironment.list({
          environmentId,
          input: {
            threadId: currentThreadId,
            driver: selectedProviderStatus?.driver ?? null,
            cwd: projectCwd,
          },
        })
      : null,
  );
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  // Mounts older settled threads matching the mention, here and on linked machines, which shells
  // may leave out.
  useThreadSearch(
    trigger?.kind === "path" && environmentId ? [environmentId, ...linkedEnvironments.keys()] : [],
    trigger?.kind === "path" ? trigger.query : "",
    { titlesOnly: true },
  );
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    threadPullRequests,
    query: trigger?.kind === "pull-request" ? trigger.query : null,
  });

  const items = ((): ComposerCommandItem[] => {
    if (!trigger) return [];

    if (trigger.kind === "pull-request") {
      return pullRequestSearch.entries.map((entry) => ({
        id: `pr:${entry.projectId}:${threadPullRequestKeyOf(entry)}`,
        type: "pull-request",
        pullRequest: {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          state: entry.state,
          isDraft: entry.isDraft,
        },
        label: `#${entry.number}`,
        description: `${entry.isDraft ? gt("Draft", { $context: "pull request state" }) : messages(PULL_REQUEST_STATE_LABELS[entry.state])} · ${
          entry.repository.toLowerCase() === pullRequestRepository?.toLowerCase()
            ? ""
            : `${entry.repository} · `
        }${entry.title}`,
      }));
    }

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const visibleSkills = getProviderSkillsForSlashMenu(skills, true);
      const commandItems = buildComposerSlashCommandItems(
        {
          query: q,
          atMessageStart: trigger.rangeStart === 0,
          hasThread,
          hasCompactableConversation,
          offersUsageLimits,
          offersFreshSession: onFreshSession !== undefined,
          offersSideChat,
          selectedProviderStatus: selectedProviderStatus
            ? {
                ...selectedProviderStatus,
                slashCommands: getProviderSlashCommandsForSlashMenu(
                  resolveProviderSlashCommandsForCwd(selectedProviderStatus, projectCwd),
                  visibleSkills,
                ),
              }
            : null,
        },
        messages,
      );

      const skillItems = visibleSkills
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...commandItems, ...skillItems];
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\p{Sc}+/u,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "agent-config") {
      const models =
        modelOptions && modelProviders
          ? buildComposerModelItems(modelOptions, trigger.query, modelProviders)
          : [];
      const groups = toolQuery.data?.groups ?? [];
      const expanded =
        trigger.query.trim() === ""
          ? new Map(groups.map((group) => [agentToolSectionId(group.source), true]))
          : OPEN_TOOL_SECTIONS;
      const tools = buildAgentToolSections(groups, trigger.query, expanded).flatMap((section) =>
        section.tools.map((tool) => ({
          id: JSON.stringify([section.group.source, tool.name]),
          type: "agent-tool" as const,
          source: section.group.source,
          tool: tool.name,
          label: `${section.group.source} > ${tool.name}`,
          description: tool.description ?? "",
        })),
      );
      return [...models, ...tools];
    }
    if (trigger.kind === "path") {
      if (isFilesystemPathQuery(trigger.query)) {
        return pathSearch.entries.map((entry) => ({
          id: `disk:${entry.path}`,
          type: "path",
          path: entry.path,
          kind: entry.kind,
          label: entry.path.split(/[/\\]/).at(-1) ?? entry.path,
          description: entry.path,
        }));
      }
      const threadItems = environmentId
        ? matchComposerThreadItems(
            {
              shells: threadShells,
              environmentId,
              linkedEnvironments,
              excludeThreadId: currentThreadId,
              query: trigger.query,
              now,
            },
            messages,
          )
        : [];
      const environmentItems = environmentId
        ? matchComposerEnvironmentItems(
            { environments, environmentId, query: trigger.query },
            messages,
          )
        : [];
      const modelItems =
        modelOptions && modelProviders
          ? buildComposerModelItems(modelOptions, trigger.query, modelProviders)
          : [];
      return [
        ...threadItems,
        ...environmentItems,
        ...modelItems,
        ...pathSearch.entries.map((entry) => {
          const parts = entry.path.split("/");
          return {
            id: `path:${entry.path}`,
            type: "path" as const,
            path: entry.path,
            kind: entry.kind,
            label: parts[parts.length - 1] ?? entry.path,
            description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
          };
        }),
      ];
    }

    return [];
  })();

  const onSelect = (item: ComposerCommandItem, dive = false) => {
    if (!trigger) return;
    if (dive && item.type === "path" && item.kind === "directory" && trigger.kind === "path") {
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `@${composerDirectoryQuery(item.path)}`,
      );
      onChangeDraftMessage(result.text);
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "environment") {
      if (!ownerKey || trigger.kind !== "path") return;
      const record = environmentComposerContext(item.environmentId, item.label);
      const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
      const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
      if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Dialog.alert(
          gt("Too many context items"),
          gt("Remove some context from the draft and try again."),
        );
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      if (!alreadyAttached) {
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
      }
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "thread") {
      if (!ownerKey || trigger.kind !== "path") return;
      const shell = threadShells.find(
        (candidate) =>
          candidate.environmentId === item.thread.environmentId &&
          candidate.id === item.thread.threadId,
      );
      if (!shell) return;
      const record = threadContextRecord(item.thread, shell.title);
      const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
      const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
      if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Dialog.alert(
          gt("Too many context items"),
          gt("Remove some context from the draft and try again."),
        );
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      if (!alreadyAttached) {
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
      }
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "pull-request") {
      if (
        !ownerKey ||
        trigger.kind !== "pull-request" ||
        !items.some((candidate) => candidate.id === item.id)
      )
        return;
      const record = pullRequestComposerContext(item.pullRequest, uuidv4());
      if (
        (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
        COMPOSER_CONTEXT_MAX_RECORDS
      ) {
        Dialog.alert(
          gt("Too many context items"),
          gt("Remove some context from the draft and try again."),
        );
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      const draft = getComposerDraftSnapshot(ownerKey);
      setComposerDraftContext(ownerKey, {
        version: 1,
        records: [...(draft.context?.records ?? []), record],
      });
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }

    const clearTriggerThen = (action: () => void) => {
      const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
      setSelection({ start: cleared.cursor, end: cleared.cursor });
      onChangeDraftMessage(cleared.text);
      action();
    };
    if (item.type === "slash-command" && item.command === "model") {
      clearTriggerThen(onOpenModelPicker);
      return;
    }
    if (item.type === "slash-command" && item.command === "clear" && onFreshSession) {
      clearTriggerThen(onFreshSession);
      return;
    }
    if (
      item.type === "provider-slash-command" &&
      item.command.name === USAGE_LIMITS_COMMAND.name &&
      onUsageLimits
    ) {
      clearTriggerThen(onUsageLimits);
      return;
    }

    if (trigger.kind === "agent-config" && item.type === "model" && onConfigureAgentModel) {
      onConfigureAgentModel(trigger, item.option);
      return;
    }
    const result = resolveComposerCommandSelection({ draftMessage, trigger, item });
    setSelection({ start: result.cursor, end: result.cursor });
    onChangeDraftMessage(result.text);
  };

  const highlightedItem =
    trigger?.kind === "path"
      ? ((highlight && highlight.ownerKey === ownerKey && highlight.query === trigger.query
          ? items.find((item) => item.id === highlight.itemId)
          : undefined) ?? items[0])
      : undefined;

  const onPickerKey = (key: ComposerPickerKey) => {
    if (trigger?.kind !== "path" || !highlightedItem) return;
    switch (key) {
      case "select":
        onSelect(highlightedItem);
        return;
      case "browse":
        onSelect(highlightedItem, true);
        return;
      case "dismiss":
        setDismissedPath({ ownerKey, position: trigger.rangeStart });
        return;
      case "previous":
      case "next": {
        const offset = key === "next" ? 1 : -1;
        const next = items[(items.indexOf(highlightedItem) + offset + items.length) % items.length];
        if (next) setHighlight({ ownerKey, query: trigger.query, itemId: next.id });
      }
    }
  };

  return {
    selection,
    onSelectionChange,
    highlightedItemId: highlightedItem?.id,
    onPickerKey: highlightedItem ? onPickerKey : undefined,
    trigger,
    items,
    skills,
    isLoading:
      trigger?.kind === "pull-request"
        ? pullRequestSearch.isPending
        : trigger?.kind === "agent-config"
          ? toolQuery.isPending
          : pathSearch.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? gt("Pull requests are unavailable for this project.")
          : pullRequestSearch.error
        : null,
    onSelect,
    onDraftChange,
  };
}

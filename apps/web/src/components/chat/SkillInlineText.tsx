import { collectComposerModelMentions } from "@t3tools/client-runtime/composer-model-mentions";
import type { EnvironmentId, ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { AgentConfigChip } from "./AgentConfigChip";
import { splitAgentConfigText } from "./agentConfigChipModel";
import { ModelMentionChip } from "./ModelMentionChip";

function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
  environmentId: EnvironmentId | null;
}) {
  const chips: Array<{ start: number; end: number; node: ReactNode }> = [];
  for (const { start, end, skill, rawText } of matchInlineSkills(props.text, props.skills)) {
    chips.push({
      start,
      end,
      node: (
        <SkillChipPopover
          key={`${start}:${skill.name}`}
          label={formatProviderSkillDisplayName(skill)}
          description={skillPopoverDescription(skill)}
          copyMarkdown={rawText}
          onViewInstructions={skillInstructionsOpener(props.threadRef, skill)}
        />
      ),
    });
  }
  for (const mention of collectComposerModelMentions(props.text)) {
    chips.push({
      start: mention.start,
      end: mention.end,
      node: (
        <ModelMentionChip
          key={`${mention.start}:model`}
          environmentId={props.environmentId}
          instanceId={mention.instanceId}
          model={mention.model}
          source={mention.source}
        />
      ),
    });
  }
  if (chips.length === 0) {
    return <>{props.text}</>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const chip of chips.toSorted((left, right) => left.start - right.start)) {
    if (chip.start < cursor) continue;
    if (chip.start > cursor) {
      nodes.push(props.text.slice(cursor, chip.start));
    }
    nodes.push(chip.node);
    cursor = chip.end;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

/** Each segment keyed by its text offset, which stays put while the message is unchanged. */
function keyedSegments(text: string) {
  let offset = 0;
  return splitAgentConfigText(text).map((segment) => {
    const keyed = { key: `${offset}`, segment };
    offset += segment.type === "text" ? segment.text.length : segment.raw.length;
    return keyed;
  });
}

function InlineChipText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
  environmentId: EnvironmentId | null;
}) {
  return (
    <>
      {keyedSegments(props.text).map(({ key, segment }) =>
        segment.type === "text" ? (
          <SkillInlineText
            key={key}
            text={segment.text}
            skills={props.skills}
            threadRef={props.threadRef}
            environmentId={props.environmentId}
          />
        ) : (
          <AgentConfigChip key={key} raw={segment.raw} />
        ),
      )}
    </>
  );
}

/** Turns `$skill` and `%[...]` chips in markdown text into their chips; other nodes pass through. */
export function renderInlineChipMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<ServerProviderSkill>,
  threadRef: ScopedThreadRef | undefined,
  environmentId: EnvironmentId | null,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return (
        <InlineChipText
          text={child}
          skills={skills}
          threadRef={threadRef}
          environmentId={environmentId}
        />
      );
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom markdown components replace intrinsic types; check their hast tags.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderInlineChipMarkdownChildren(child.props.children, skills, threadRef, environmentId),
    );
  });
}

export function skillPopoverDescription(
  skill: Pick<ServerProviderSkill, "description" | "shortDescription">,
) {
  return skill.description?.trim() || skill.shortDescription?.trim() || null;
}

export function skillInstructionsOpener(
  threadRef: ScopedThreadRef | null | undefined,
  skill: Pick<ServerProviderSkill, "path"> | undefined,
) {
  if (!threadRef || !skill?.path) return undefined;
  return () => useRightPanelStore.getState().openFile(threadRef, skill.path);
}

export function SkillChipPopover(props: {
  label: string;
  description: string | null | undefined;
  copyMarkdown?: string | undefined;
  onViewInstructions: (() => void) | undefined;
}) {
  return (
    <ContextChipPopover
      kind="skill"
      icon={<SkillChipIcon />}
      label={props.label}
      accessibleLabel={`Skill ${props.label}`}
      copyMarkdown={props.copyMarkdown}
    >
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{props.description || "No description is available for this skill."}</p>
        {props.onViewInstructions ? (
          <Button variant="outline" size="sm" onClick={props.onViewInstructions}>
            View instructions
          </Button>
        ) : null}
      </div>
    </ContextChipPopover>
  );
}

export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ResponseContextRecord } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, PencilIcon, QuoteIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { textDirection } from "~/textDirection";

function useCitationSourceLinkProps(citation: AssistantCitation) {
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(
    scopeThreadRef(citation.environmentId, citation.threadId),
  );
  return {
    ...assistantCitationRoute(citation, sourceThread),
    "data-markdown-copy": serializeAssistantCitation(citation),
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation, sourceThread));
    },
  };
}

const flat = (text: string) => text.replace(/\s+/g, " ");

function ResponseCard({
  citation,
  copyMarkdown,
  label,
  title,
  preview,
  comment,
  leading,
  trailing,
  onRemove,
  reply = false,
}: {
  citation: AssistantCitation;
  copyMarkdown: string;
  label: string;
  title?: string | undefined;
  preview: ReactNode;
  comment?: ReactNode;
  leading: boolean;
  trailing: boolean;
  onRemove?: (() => void) | undefined;
  reply?: boolean;
}) {
  const linkProps = useCitationSourceLinkProps(citation);
  const [expanded, setExpanded] = useState(false);
  const quote = (
    <>
      <QuoteIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {title ? (
          <span className="block truncate text-xs font-medium text-foreground/80" dir="auto">
            {title}
          </span>
        ) : null}
        <span
          className={cn(
            "block border-s-2 border-border ps-2 italic",
            !expanded && (reply ? "line-clamp-2" : "line-clamp-3"),
          )}
          dir={textDirection(citation.text)}
        >
          {preview}
        </span>
      </span>
    </>
  );
  return (
    // One copy boundary for the card and its comment, so a copied card carries the comment once.
    <span
      data-markdown-copy={copyMarkdown}
      data-assistant-citation-card="true"
      className={cn(
        "relative block min-w-0 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm wrap-break-word",
        !leading && "mt-[0.65rem]",
        !trailing && "mb-[0.65rem]",
      )}
    >
      <span contentEditable={false} data-thread-find-ignore className="block">
        {reply ? (
          <Link
            {...linkProps}
            data-markdown-copy={undefined}
            aria-label={label}
            className="flex w-full items-start gap-2 text-start text-muted-foreground! no-underline! hover:text-foreground! focus-visible:outline-2 focus-visible:outline-ring"
          >
            {quote}
          </Link>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse quoted response" : "Expand quoted response"}
              onClick={() => setExpanded((value) => !value)}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2 text-start text-muted-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring",
                onRemove ? "pe-12" : "pe-5",
              )}
            >
              {quote}
            </button>
            <Link
              {...linkProps}
              data-markdown-copy={undefined}
              aria-label={label}
              title="Go to source"
              onClick={(event) => {
                event.stopPropagation();
                linkProps.onClick(event);
              }}
              className={cn(
                "absolute top-2 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground! no-underline! hover:text-foreground! focus-visible:outline-2 focus-visible:outline-ring",
                onRemove ? "end-8" : "end-2",
              )}
            >
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </>
        )}
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove quoted response: ${assistantCitationLabel({ ...citation, comment: undefined })}`}
            className="absolute end-1.5 top-1.5 inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }}
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </span>
      {comment !== undefined && comment !== null ? (
        <span
          className="mt-2 block border-t border-border/50 pt-2 whitespace-pre-wrap"
          dir={typeof comment === "string" ? textDirection(comment) : undefined}
        >
          {comment}
        </span>
      ) : null}
    </span>
  );
}

/** A passage quoted from a response, with its surrounding context and the user's comment. */
export function AssistantCitationEmbed({
  citation,
  leading,
  trailing,
  onRemove,
  commentContent,
}: {
  citation: AssistantCitation;
  leading: boolean;
  trailing: boolean;
  onRemove?: (() => void) | undefined;
  commentContent?: ReactNode;
}) {
  const wholeResponse = citation.prefix === "" && citation.suffix === "";
  const { comment, ...quoted } = citation;
  return (
    <ResponseCard
      citation={citation}
      copyMarkdown={serializeAssistantCitation(citation)}
      label={`Go to quoted response: ${assistantCitationLabel(quoted)}`}
      comment={commentContent ?? (comment || undefined)}
      leading={leading}
      trailing={trailing}
      onRemove={onRemove}
      preview={
        wholeResponse ? (
          flat(citation.text)
        ) : (
          <>
            {citation.prefix ? `…${flat(citation.prefix)}` : null}
            <mark className="rounded-sm bg-foreground/12 px-0.5 text-foreground">
              {flat(citation.text)}
            </mark>
            {citation.suffix ? `${flat(citation.suffix)}…` : null}
          </>
        )
      }
    />
  );
}

/** The response a message replies to: its subagents, when it had any, and how it starts. */
export function ResponseReplyCard({
  record,
  copyMarkdown,
  leading,
  trailing,
}: {
  record: ResponseContextRecord;
  copyMarkdown: string;
  leading: boolean;
  trailing: boolean;
}) {
  return (
    <ResponseCard
      citation={record.citation}
      copyMarkdown={copyMarkdown}
      label={`Go to the response this replies to: ${record.label}`}
      title={record.subagents?.map((subagent) => subagent.title).join(", ")}
      preview={flat(record.citation.text)}
      leading={leading}
      trailing={trailing}
      reply
    />
  );
}

/** The citation chip in the composer, with its comment editor. */
export function AssistantCitationChip({
  citation,
  commentEditor,
}: {
  citation: AssistantCitation;
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const sourceLinkProps = useCitationSourceLinkProps(citation);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the uncommitted comment draft held in a ref once the parent closes the comment editor
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the cited DOM source while the comment editor is open and reacts when it disappears
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = activeSourceAnchor.range.getClientRects();
          const rect =
            rects.item(rects.length - 1) ?? activeSourceAnchor.range.getBoundingClientRect();
          // Code blocks and tables scroll sideways inside the message, so the cited
          // text can end in their hidden overflow. Base UI only shifts the popup while
          // it still touches the anchor, so clamp the anchor to the message's width.
          const bounds = activeSourceAnchor.source.getBoundingClientRect();
          const left = Math.min(Math.max(rect.left, bounds.left), bounds.right);
          const right = Math.max(Math.min(rect.right, bounds.right), left);
          return new DOMRect(left, rect.top, right - left, rect.height);
        },
      }
    : undefined;
  const label = assistantCitationLabel(citation);
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex min-w-0 items-center gap-[0.2em] self-baseline text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]" dir={textDirection(label)}>
        {label}
      </ContextChipLabel>
    </Link>
  );
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {composerSourceLink}
      {commentEditor ? (
        <Popover
          open={commentEditor.open && !voiceSetupOpen}
          onOpenChange={(open, eventDetails) => {
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            data-citation-comment-trigger="true"
            render={<ContextChipAction />}
          >
            <PencilIcon aria-hidden="true" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              // The editor stays mounted while its voice setup dialog replaces the popover.
              keepMounted
              {...composerFloatingLayerProps}
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                const input = commentInputRef.current;
                if (input) {
                  input.focus({ preventScroll: true });
                  input.setSelectionRange(input.value.length, input.value.length);
                  // Moving the caret doesn't scroll a long comment to it.
                  input.scrollTop = input.scrollHeight;
                }
                return false;
              }}
              finalFocus={
                commentEditor.onRestoreFocus
                  ? () => {
                      const activeElement = document.activeElement;
                      if (
                        activeElement === document.body ||
                        (activeElement !== null && commentPopupRef.current?.contains(activeElement))
                      ) {
                        commentEditor.onRestoreFocus?.();
                      }
                      return false;
                    }
                  : undefined
              }
              ref={commentPopupRef}
              aria-label="Edit citation comment"
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeAssistantCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
                onVoiceSetupOpenChange={setVoiceSetupOpen}
                onDraftChange={(comment) => {
                  draftCommentRef.current = comment;
                  commentEditor.onDraftChange?.(comment);
                }}
                onSubmit={(comment) => {
                  if (!commentEditor.onSave(comment)) return false;
                  commentEditor.onOpenChange(false);
                  return true;
                }}
                {...(commentEditor.onSaveAndSend
                  ? {
                      onSubmitAndSend: (comment: string) => {
                        if (!commentEditor.onSaveAndSend?.(comment)) return false;
                        commentEditor.onOpenChange(false);
                        return true;
                      },
                    }
                  : {})}
                onCancel={() => {
                  if (commentEditor.onCancel) {
                    commentEditor.onCancel();
                  } else {
                    commentEditor.onOpenChange(false);
                  }
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : null}
    </ContextChip>
  );
}

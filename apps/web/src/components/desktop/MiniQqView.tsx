import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, PlusIcon, XIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import {
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
  type DraftId,
} from "../../composerDraftStore";
import { readLastUsedProjectKey } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { getClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isMacPlatform, newDraftId, newThreadId } from "../../lib/utils";
import { readProjects, useProjects, useQuietThreadShell } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MINI_QQ_LOGICAL_PROJECT_KEY = "__mini-qq__";

interface MiniQqSession {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  readonly draftThreadId: ThreadId;
}

const ZERO_WINDOW_CONTROLS_INSET_STYLE = {
  "--desktop-window-controls-inset": "0px",
} as CSSProperties;

function hasOpenOverlayInDocument(): boolean {
  return (
    document.querySelector(
      "[role='listbox'], [role='menu'], [role='dialog'], [data-popup-open], [data-open]",
    ) !== null
  );
}

function focusMiniQqComposer(container: HTMLElement | null) {
  if (!container) return;
  window.requestAnimationFrame(() => {
    const editable = container.querySelector<HTMLElement>(
      "[contenteditable='true'], textarea, input[type='text']",
    );
    editable?.focus();
  });
}

export function MiniQqView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initializingRef = useRef(false);
  const navigate = useNavigate();
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: true,
  });

  const [session, setSession] = useState<MiniQqSession | null>(null);
  const [promotedByDraft, setPromotedByDraft] = useState<{
    readonly draftId: DraftId;
    readonly threadRef: ScopedThreadRef;
  } | null>(null);
  const [promotingToMain, setPromotingToMain] = useState(false);

  const storePromotedRedirect = useComposerDraftStore((store) =>
    session ? store.getPromotedDraftRedirect(session.draftId) : null,
  );

  if (
    session !== null &&
    storePromotedRedirect !== null &&
    (promotedByDraft === null || promotedByDraft.draftId !== session.draftId)
  ) {
    setPromotedByDraft({
      draftId: session.draftId,
      threadRef: storePromotedRedirect,
    });
  }

  const activeServerThreadRef =
    session !== null && promotedByDraft?.draftId === session.draftId
      ? promotedByDraft.threadRef
      : null;
  const activeServerShell = useQuietThreadShell(activeServerThreadRef);
  const activeServerDetail = useEnvironmentThread(
    activeServerThreadRef?.environmentId ?? null,
    activeServerThreadRef?.threadId ?? null,
  );
  const activeServerDetailTitle = Option.getOrNull(
    Option.map(activeServerDetail.data, (projection) => projection.thread.title),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finalizes the promoted draft entry once MiniQqView switches ChatView from draft to server mode
  useEffect(() => {
    if (!activeServerThreadRef) return;
    finalizePromotedDraftThreadByRef(activeServerThreadRef);
  }, [activeServerThreadRef]);

  const resolveDefaultProjectRef = async (): Promise<ScopedProjectRef | null> => {
    const primaryEnvId = primaryEnvironment?.environmentId ?? null;
    const scratchEnvId = scratchEnvironmentId(primaryEnvId);
    if (scratchEnvId !== null) {
      const scratchProject = await openScratchProject(
        scratchEnvId,
        "Could not prepare Quick Question workspace",
      );
      if (scratchProject) {
        return scopeProjectRef(scratchProject.environmentId, scratchProject.id);
      }
    }

    const availableProjects = readProjects();
    if (availableProjects.length === 0) return null;

    const lastUsedKey = readLastUsedProjectKey();
    if (lastUsedKey) {
      const grouping = selectProjectGroupingSettings(getClientSettings());
      const matched = availableProjects.find(
        (candidate) => deriveLogicalProjectKeyFromSettings(candidate, grouping) === lastUsedKey,
      );
      if (matched) {
        return scopeProjectRef(matched.environmentId, matched.id);
      }
    }

    const primaryProject =
      primaryEnvId === null
        ? undefined
        : availableProjects.find((candidate) => candidate.environmentId === primaryEnvId);
    const fallback = primaryProject ?? availableProjects[0];
    return fallback ? scopeProjectRef(fallback.environmentId, fallback.id) : null;
  };

  const startFreshSession = async (
    previousSession?: MiniQqSession | null,
    hadServerThread?: boolean,
  ) => {
    if (initializingRef.current) return;
    initializingRef.current = true;
    try {
      const projectRef = await resolveDefaultProjectRef();
      if (!projectRef) return;

      const store = useComposerDraftStore.getState();
      if (previousSession && !hadServerThread) {
        store.clearDraftThread(previousSession.draftId);
      }

      const draftId = newDraftId();
      const draftThreadId = newThreadId();
      store.setLogicalProjectDraftThreadId(MINI_QQ_LOGICAL_PROJECT_KEY, projectRef, draftId, {
        threadId: draftThreadId,
        branch: null,
        worktreePath: null,
        envMode: "local",
        createdAt: new Date().toISOString(),
      });
      store.applyStickyState(draftId);

      setPromotedByDraft(null);
      setSession({
        draftId,
        environmentId: projectRef.environmentId,
        draftThreadId,
      });
      focusMiniQqComposer(containerRef.current);
    } finally {
      initializingRef.current = false;
    }
  };

  const startFreshSessionStable = useStableCallback(startFreshSession);

  const primaryConnected =
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bootstraps the initial quick-question draft once an environment or project list is ready
  useEffect(() => {
    if (session !== null) return;
    if (!primaryConnected && projects.length === 0) return;
    void startFreshSessionStable(null, false);
  }, [primaryConnected, projects.length, session, startFreshSessionStable]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop Mini QQ activation events so summoning focuses the composer
  useEffect(() => {
    const miniQq = window.desktopBridge?.miniQq;
    if (!miniQq) return;
    return miniQq.onActivate(({ focusComposer }) => {
      if (focusComposer) {
        focusMiniQqComposer(containerRef.current);
      }
    });
  }, []);

  const handleReset = () => {
    void startFreshSession(session, activeServerThreadRef !== null);
  };

  const handleHide = () => {
    void window.desktopBridge?.miniQq?.hide();
  };

  const handleOpenInMainWindow = async () => {
    if (!activeServerThreadRef || promotingToMain) return;
    setPromotingToMain(true);
    try {
      const result = await updateThreadMetadata({
        environmentId: activeServerThreadRef.environmentId,
        input: {
          threadId: activeServerThreadRef.threadId,
          quickQuestion: false,
        },
      });
      if (result._tag === "Failure") return;

      const routePath = `/${encodeURIComponent(activeServerThreadRef.environmentId)}/${encodeURIComponent(activeServerThreadRef.threadId)}`;
      const currentSession = session;
      if (window.desktopBridge?.miniQq) {
        await window.desktopBridge.miniQq.openInMainWindow(routePath);
        await startFreshSession(currentSession, true);
      } else {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(activeServerThreadRef),
        });
      }
    } finally {
      setPromotingToMain(false);
    }
  };

  const onWindowKeyDown = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && !event.altKey && !event.shiftKey && key === "n") {
      event.preventDefault();
      handleReset();
      return;
    }

    if (mod && !event.altKey && event.shiftKey && key === "o") {
      if (activeServerThreadRef) {
        event.preventDefault();
        void handleOpenInMainWindow();
      }
      return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "w") {
      if (window.desktopBridge?.miniQq) {
        event.preventDefault();
        handleHide();
      }
      return;
    }

    if (
      event.key === "Escape" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      window.desktopBridge?.miniQq &&
      !hasOpenOverlayInDocument()
    ) {
      event.preventDefault();
      handleHide();
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers window-level keyboard shortcuts for hiding, resetting, and promoting the quick-question window
  useEffect(() => {
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [onWindowKeyDown]);

  const mac = isMacPlatform(navigator.platform);
  const newShortcutLabel = mac ? "⌘N" : "Ctrl+N";
  const promoteShortcutLabel = mac ? "⌘⇧O" : "Ctrl+Shift+O";
  const headerTitle =
    activeServerShell?.title?.trim() || activeServerDetailTitle?.trim() || "Quick Question";

  return (
    <div
      ref={containerRef}
      style={ZERO_WINDOW_CONTROLS_INSET_STYLE}
      data-mini-qq-root=""
      className="flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="drag-region flex h-10 shrink-0 select-none items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-3">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {headerTitle}
        </span>

        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="xs"
                  onClick={handleReset}
                  aria-label="New quick question"
                >
                  <PlusIcon className="size-3.5" />
                  <span>New</span>
                </Button>
              }
            />
            <TooltipPopup side="bottom">New quick question ({newShortcutLabel})</TooltipPopup>
          </Tooltip>

          {activeServerThreadRef ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={promotingToMain}
                    onClick={() => void handleOpenInMainWindow()}
                    aria-label="Open in main window"
                  >
                    <span>Open in main</span>
                    <ArrowUpRightIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                Open in main window ({promoteShortcutLabel})
              </TooltipPopup>
            </Tooltip>
          ) : null}

          {window.desktopBridge?.miniQq ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={handleHide}
                    aria-label="Hide Quick Question"
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">Hide (Esc)</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {session === null ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            Connecting…
          </div>
        ) : activeServerThreadRef ? (
          <ChatView
            key={session.draftId}
            environmentId={activeServerThreadRef.environmentId}
            threadId={activeServerThreadRef.threadId}
            routeKind="server"
            miniQq
            reserveTitleBarControlInset={false}
          />
        ) : (
          <ChatView
            key={session.draftId}
            draftId={session.draftId}
            environmentId={session.environmentId}
            threadId={session.draftThreadId}
            routeKind="draft"
            miniQq
            reserveTitleBarControlInset={false}
            forceExpandedMobileComposer
          />
        )}
      </div>
    </div>
  );
}

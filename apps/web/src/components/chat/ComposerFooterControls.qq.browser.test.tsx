import "~/index.css";

import { useRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import { hasComposerQqChip } from "~/composer-rich-text-doc";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

function baseProps(): ComponentProps<typeof ComposerFooterPrimaryActions> {
  return {
    compact: false,
    canOperateThread: true,
    qqActive: false,
    qqDisabled: false,
    onToggleQq: vi.fn(),
    activeContextWindow: null,
    contextBreakdown: null,
    reserveContextWindowMeter: false,
    activeThreadModelDisplayName: null,
    compactDisabled: false,
    isPreparingWorktree: false,
    pendingAction: null,
    isRunning: false,
    canInterrupt: false,
    runId: null,
    followUpBehavior: "queue",
    canSteer: false,
    alternateShortcutLabel: null,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    hasSendableContent: false,
    canResume: false,
    isEditingQueuedMessage: false,
    onSubmitMessage: vi.fn(),
    onResume: vi.fn(),
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    compactBeforeSendTokens: null,
    hideCompactToggle: true,
    keepFullHistory: true,
    onToggleKeepFullHistory: vi.fn(),
  };
}

it("hides the QQ button when composer-surface is compressed and shows it when wide", async () => {
  const props = baseProps();
  await using screen = await render(
    <TooltipProvider>
      <div className="@container/composer-surface" style={{ width: "360px" }}>
        <ComposerFooterPrimaryActions {...props} />
      </div>
    </TooltipProvider>,
    { router: false },
  );

  const qq = screen.container.querySelector(
    '[data-testid="composer-qq-button"]',
  ) as HTMLButtonElement;
  expect(qq).not.toBeNull();
  expect(getComputedStyle(qq).display).toBe("none");

  await screen.rerender(
    <TooltipProvider>
      <div className="@container/composer-surface" style={{ width: "640px" }}>
        <ComposerFooterPrimaryActions {...props} />
      </div>
    </TooltipProvider>,
  );
  expect(getComputedStyle(qq).display).toBe("inline-flex");
});

it("toggles one /qq chip per draft and reflects active state via aria-pressed", async () => {
  function Harness() {
    const [draft, setDraft] = useState("");
    const editorRef = useRef<ComposerPromptEditorHandle>(null);
    const qqActive = hasComposerQqChip(draft);
    return (
      <TooltipProvider>
        <div className="@container/composer-surface" style={{ width: "640px" }}>
          <ComposerPromptEditorTiptap
            editorRef={editorRef}
            value={draft}
            cursor={draft.length}
            contextRecords={new Map()}
            skills={[]}
            disabled={false}
            placeholder=""
            onChange={setDraft}
            onPaste={() => {}}
          />
          <ComposerFooterPrimaryActions
            {...baseProps()}
            qqActive={qqActive}
            hasSendableContent={draft.trim().length > 0}
            onToggleQq={() => {
              if (hasComposerQqChip(draft)) editorRef.current?.removeQqChips();
              else setDraft(`${draft}/qq `);
            }}
            onSubmitMessage={() => {
              setDraft("");
            }}
          />
          <output data-testid="draft-value">{draft}</output>
        </div>
      </TooltipProvider>
    );
  }

  await using screen = await render(<Harness />, { router: false });
  const qq = screen.getByTestId("composer-qq-button").element() as HTMLButtonElement;
  const output = screen.getByTestId("draft-value").element();

  expect(qq.getAttribute("aria-pressed")).toBe("false");
  const inactiveBackground = getComputedStyle(qq).backgroundColor;

  await act(() => qq.click());
  expect(output.textContent).toBe("/qq ");
  expect(qq.getAttribute("aria-pressed")).toBe("true");
  expect(getComputedStyle(qq).backgroundColor).not.toBe(inactiveBackground);

  await act(() => qq.click());
  expect(output.textContent).toBe("");
  expect(qq.getAttribute("aria-pressed")).toBe("false");
  expect(getComputedStyle(qq).backgroundColor).toBe(inactiveBackground);

  await act(() => qq.click());
  expect(output.textContent).toBe("/qq ");
  expect(qq.getAttribute("aria-pressed")).toBe("true");

  const submit = screen
    .getByRole("button", { name: "Submit message" })
    .element() as HTMLButtonElement;
  await act(() => submit.click());
  expect(output.textContent).toBe("");
  expect(qq.getAttribute("aria-pressed")).toBe("false");
  expect(getComputedStyle(qq).backgroundColor).toBe(inactiveBackground);
});

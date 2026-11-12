import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { insertAssistantCitationIntoPrompt } from "../composer-logic";
import ChatMarkdown from "./ChatMarkdown";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const firstCitation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  text: "quoted passage",
  start: 7,
  end: 21,
  prefix: "before ",
  suffix: " after",
};

const secondCitation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-2"),
  text: "second excerpt",
  start: 0,
  end: 14,
  prefix: "",
  suffix: " tail",
};

function Harness(props: { initialValue: string }) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [value, setValue] = useState(props.initialValue);
  const [cursor, setCursor] = useState(props.initialValue.length);

  return (
    <div>
      <div data-testid="composer-surface">
        <ComposerPromptEditor
          draftKey="thread-1"
          ariaLabel="Message"
          editorRef={editorRef}
          richTextEnabled={true}
          value={value}
          cursor={cursor}
          skills={[]}
          contextRecords={new Map()}
          placeholder="Ask anything"
          disabled={false}
          onChange={(nextValue, nextCursor) => {
            setValue(nextValue);
            setCursor(nextCursor);
          }}
          onCommandKeyDown={() => false}
          onPaste={() => {}}
        />
      </div>
      <div data-testid="sent-surface">
        <ChatMarkdown text={value} cwd={undefined} isStreaming={false} lineBreaks />
      </div>
      <pre data-testid="serialized-value">{value}</pre>
    </div>
  );
}

describe("ComposerPromptEditor citation cards", () => {
  it("renders multiple cited passages and rich-text commentary identically to sent messages and removes quotes cleanly", async () => {
    const commentedFirst = { ...firstCitation, comment: "Explain **why** this happens" };
    const firstInsert = insertAssistantCitationIntoPrompt("", 0, commentedFirst);
    const withFirstComment = firstInsert.text;
    const secondInsert = insertAssistantCitationIntoPrompt(
      withFirstComment,
      withFirstComment.length,
      { ...secondCitation, comment: "And compare with `main`" },
    );
    const initialDraft = secondInsert.text;

    await using screen = await render(<Harness initialValue={initialDraft} />);
    const composerSurface = screen.container.querySelector('[data-testid="composer-surface"]')!;
    const sentSurface = screen.container.querySelector('[data-testid="sent-surface"]')!;

    await expect
      .element(page.getByRole("button", { name: "Remove quoted response: quoted passage" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove quoted response: second excerpt" }))
      .toBeInTheDocument();

    const composerCards = composerSurface.querySelectorAll('[data-assistant-citation-card="true"]');
    const sentCards = sentSurface.querySelectorAll('[data-assistant-citation-card="true"]');
    expect(composerCards.length).toBe(2);
    expect(sentCards.length).toBe(2);
    expect(composerCards[0]?.querySelector("mark")?.textContent).toBe("quoted passage");
    expect(sentCards[0]?.querySelector("mark")?.textContent).toBe("quoted passage");
    expect(composerCards[1]?.querySelector("mark")?.textContent).toBe("second excerpt");
    expect(sentCards[1]?.querySelector("mark")?.textContent).toBe("second excerpt");
    expect(composerSurface.querySelector("strong")?.textContent).toBe("why");
    expect(composerSurface.querySelector("code")?.textContent).toBe("main");
    expect(composerCards[0]?.querySelector("strong")?.textContent).toBe("why");
    expect(composerCards[1]?.querySelector("code")?.textContent).toBe("main");
    expect(sentCards[0]?.textContent).toContain("Explain **why** this happens");
    expect(sentCards[1]?.textContent).toContain("And compare with `main`");

    await userEvent.click(page.getByText("Explain why this happens", { exact: true }));
    await userEvent.keyboard("{End}!");
    await vi.waitFor(() => {
      const value = screen.container.querySelector(
        '[data-testid="serialized-value"]',
      )!.textContent!;
      expect(collectAssistantCitations(value)[0]?.citation.comment).toBe(
        "Explain **why** this happens!",
      );
    });

    await userEvent.keyboard("{Shift>}{Enter}{/Shift}More");
    const paste = async (text: string) => {
      await act(async () => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        composerSurface
          .querySelector('[role="textbox"]')!
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
      });
    };
    await paste(" **detail**\nfrom paste");
    const expectedComment = "Explain **why** this happens!\nMore **detail**\nfrom paste";
    const currentCitations = () =>
      collectAssistantCitations(
        screen.container.querySelector('[data-testid="serialized-value"]')!.textContent!,
      );
    await vi.waitFor(() => expect(currentCitations()[0]?.citation.comment).toBe(expectedComment));
    await paste("x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH));
    expect(currentCitations()[0]?.citation.comment).toBe(expectedComment);
    expect(composerCards[0]!.querySelectorAll("strong")).toHaveLength(2);

    await userEvent.click(
      page.getByRole("button", { name: "Remove quoted response: quoted passage" }),
    );

    const expectedRemaining = `${serializeAssistantCitation({ ...secondCitation, comment: "And compare with `main`" })}\n`;
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-testid="serialized-value"]')?.textContent).toBe(
        expectedRemaining,
      ),
    );
    expect(composerSurface.querySelectorAll('[data-assistant-citation-card="true"]').length).toBe(
      1,
    );
  });
});

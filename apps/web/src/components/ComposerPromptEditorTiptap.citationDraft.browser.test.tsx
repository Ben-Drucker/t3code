import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";

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
    const firstInsert = insertAssistantCitationIntoPrompt("", 0, firstCitation);
    const withFirstComment = `${firstInsert.text}Explain **why** this happens`;
    const secondInsert = insertAssistantCitationIntoPrompt(
      withFirstComment,
      withFirstComment.length,
      secondCitation,
    );
    const initialDraft = `${secondInsert.text}And compare with \`main\``;

    const screen = await render(<Harness initialValue={initialDraft} />);
    try {
      const composerSurface = screen.container.querySelector('[data-testid="composer-surface"]')!;
      const sentSurface = screen.container.querySelector('[data-testid="sent-surface"]')!;

      await expect
        .element(page.getByRole("button", { name: "Remove quoted response: quoted passage" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Remove quoted response: second excerpt" }))
        .toBeInTheDocument();

      const composerCards = composerSurface.querySelectorAll(
        '[data-assistant-citation-card="true"]',
      );
      const sentCards = sentSurface.querySelectorAll('[data-assistant-citation-card="true"]');
      expect(composerCards.length).toBe(2);
      expect(sentCards.length).toBe(2);
      expect(composerCards[0]?.querySelector("mark")?.textContent).toBe("quoted passage");
      expect(sentCards[0]?.querySelector("mark")?.textContent).toBe("quoted passage");
      expect(composerCards[1]?.querySelector("mark")?.textContent).toBe("second excerpt");
      expect(sentCards[1]?.querySelector("mark")?.textContent).toBe("second excerpt");
      expect(composerSurface.querySelector("strong")?.textContent).toBe("why");
      expect(composerSurface.querySelector("code")?.textContent).toBe("`main`");
      expect(sentSurface.querySelector("strong")?.textContent).toBe("why");
      expect(sentSurface.querySelector("code")?.textContent).toBe("main");

      await userEvent.click(
        page.getByRole("button", { name: "Remove quoted response: quoted passage" }),
      );

      const expectedRemaining = `Explain **why** this happens\n${serializeAssistantCitation(secondCitation)}\nAnd compare with \`main\``;
      await expect
        .poll(() => screen.container.querySelector('[data-testid="serialized-value"]')?.textContent)
        .toBe(expectedRemaining);
      expect(composerSurface.querySelectorAll('[data-assistant-citation-card="true"]').length).toBe(
        1,
      );
    } finally {
      await screen.unmount();
    }
  });
});

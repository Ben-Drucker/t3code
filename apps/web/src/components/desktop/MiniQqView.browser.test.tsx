import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { MiniQqView } from "./MiniQqView";

const workspace = vi.hoisted(() => ({ ready: false, dispatch: vi.fn() }));

vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => (workspace.ready ? EnvironmentId.make("mini-qq-local") : null),
    openScratchProject: async () => ({
      id: ProjectId.make("mini-qq-scratch"),
      environmentId: EnvironmentId.make("mini-qq-local"),
    }),
  }),
}));

vi.mock("../ChatView", () => ({
  default: function ReadyComposer(props: {
    draftId: DraftId;
    startupMessage?: { text: string; take: () => boolean };
  }) {
    const draft = useComposerDraftStore.getState().getComposerDraft(props.draftId);
    return (
      <>
        <textarea aria-label="Connected composer" readOnly value={draft?.prompt ?? ""} />
        <button
          type="button"
          onClick={() => {
            if (props.startupMessage?.take()) workspace.dispatch(props.startupMessage.text);
          }}
        >
          Composer ready to dispatch
        </button>
      </>
    );
  },
}));

it.each([true, false])(
  "hands a startup draft to the connected composer (submit: %s)",
  async (submit) => {
    workspace.ready = false;
    workspace.dispatch.mockClear();

    await using screen = await render(<MiniQqView />);
    const startupComposer = screen.getByRole("textbox", { name: "Quick Question message" });
    await expect.element(startupComposer).toHaveFocus();
    await startupComposer.fill("What changed?\nShow the short version.");
    if (submit) {
      await userEvent.keyboard("{Enter}");
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent("Will send when connected");
    }
    expect(workspace.dispatch).not.toHaveBeenCalled();

    workspace.ready = true;
    await screen.rerender(<MiniQqView />);
    await expect
      .element(screen.getByRole("textbox", { name: "Connected composer" }))
      .toHaveValue("What changed?\nShow the short version.");

    const dispatch = screen.getByRole("button", { name: "Composer ready to dispatch" });
    await dispatch.click();
    await dispatch.click();
    expect(workspace.dispatch.mock.calls).toEqual(
      submit ? [["What changed?\nShow the short version."]] : [],
    );
  },
);

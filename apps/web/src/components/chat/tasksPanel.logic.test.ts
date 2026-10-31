import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTasksPanelModel,
  formatStepDuration,
  selectLatestTodoList,
} from "./tasksPanel.logic";

const todo = (
  id: string,
  status: "draft" | "active" | "completed" | "superseded",
  steps: ReadonlyArray<{ id: string; text: string; status: "pending" | "running" | "completed" }>,
  explanation?: string,
) =>
  ({
    id,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "node-1",
    status,
    kind: "todo_list",
    steps,
    ...(explanation === undefined ? {} : { explanation }),
  }) as unknown as OrchestrationV2PlanArtifact;

const proposed = (id: string) =>
  ({
    id,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "node-1",
    status: "active",
    kind: "proposed_plan",
    markdown: "# Plan",
  }) as unknown as OrchestrationV2PlanArtifact;

describe("tasks panel logic", () => {
  it("shows only todo lists, never proposed plans", () => {
    expect(selectLatestTodoList([proposed("p1")])).toBeNull();
    expect(deriveTasksPanelModel([proposed("p1")])).toBeNull();
  });

  it("uses the newest todo list that was not superseded", () => {
    const plans = [
      todo("a", "completed", [{ id: "1", text: "old", status: "completed" }]),
      todo("b", "active", [{ id: "1", text: "current", status: "running" }]),
      todo("c", "superseded", [{ id: "1", text: "stale", status: "pending" }]),
    ];
    expect(selectLatestTodoList(plans)?.id).toBe("b");
  });

  it("falls back to the last list when every list was superseded", () => {
    const plans = [
      todo("a", "superseded", [{ id: "1", text: "x", status: "pending" }]),
      todo("b", "superseded", [{ id: "1", text: "y", status: "pending" }]),
    ];
    expect(selectLatestTodoList(plans)?.id).toBe("b");
  });

  it("counts progress and trims the explanation", () => {
    const model = deriveTasksPanelModel([
      todo(
        "a",
        "active",
        [
          { id: "1", text: "one", status: "completed" },
          { id: "2", text: "two", status: "running" },
          { id: "3", text: "three", status: "pending" },
        ],
        "  Working through it  ",
      ),
    ]);
    expect(model).toMatchObject({
      completed: 1,
      running: 1,
      total: 3,
      explanation: "Working through it",
    });
  });

  it("treats a blank explanation as absent", () => {
    const model = deriveTasksPanelModel([
      todo("a", "active", [{ id: "1", text: "one", status: "pending" }], "   "),
    ]);
    expect(model?.explanation).toBeNull();
  });

  it("formats step durations compactly", () => {
    expect(formatStepDuration(undefined)).toBeNull();
    expect(formatStepDuration(0)).toBeNull();
    expect(formatStepDuration(3200)).toBe("3.2s");
    expect(formatStepDuration(42_000)).toBe("42s");
    expect(formatStepDuration(65_000)).toBe("1m 05s");
    expect(formatStepDuration(3_660_000)).toBe("1h 01m");
  });
});

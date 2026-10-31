import type { OrchestrationV2PlanArtifact, OrchestrationV2PlanStep } from "@t3tools/contracts";

export type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

export interface TasksPanelModel {
  readonly planId: string;
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly explanation: string | null;
  readonly completed: number;
  readonly total: number;
  readonly running: number;
}

/**
 * The agent's current todo list: the most recent `todo_list` plan, ignoring ones a newer list
 * superseded. Plans arrive in projection order, so the last one wins.
 */
export function selectLatestTodoList(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
): TodoListPlan | null {
  const todoLists = plans.filter((plan): plan is TodoListPlan => plan.kind === "todo_list");
  const live = todoLists.filter((plan) => plan.status !== "superseded");
  return (live.length > 0 ? live : todoLists).at(-1) ?? null;
}

export function deriveTasksPanelModel(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
): TasksPanelModel | null {
  const plan = selectLatestTodoList(plans);
  if (plan === null) return null;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const running = plan.steps.filter((step) => step.status === "running").length;
  const explanation = plan.explanation?.trim() ?? "";
  return {
    planId: plan.id,
    steps: plan.steps,
    explanation: explanation.length > 0 ? explanation : null,
    completed,
    total: plan.steps.length,
    running,
  };
}

/** "1m 05s", "42s", "3.2s"; null when the step has no recorded duration. */
export function formatStepDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || durationMs <= 0) return null;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

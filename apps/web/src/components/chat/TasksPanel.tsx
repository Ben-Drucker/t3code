import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleIcon, ListTodoIcon, LoaderCircleIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadProjection } from "~/state/entities";
import { deriveTasksPanelModel, formatStepDuration } from "./tasksPanel.logic";

const STATUS_LABEL = {
  pending: "Pending",
  running: "In progress",
  completed: "Completed",
} as const;

/** Fork: the agent's todo list for this thread, and nothing else. */
export const TasksPanel = memo(function TasksPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const projection = useQuietThreadProjection(props.threadRef);
  const model = deriveTasksPanelModel(projection?.projection.plans ?? []);

  if (model === null || model.total === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm"
        data-testid="tasks-panel-empty"
      >
        <ListTodoIcon className="size-6 opacity-60" />
        <p>No tasks yet.</p>
        <p className="text-xs opacity-80">
          When the agent writes a todo list, its steps show up here.
        </p>
      </div>
    );
  }

  const percent = Math.round((model.completed / model.total) * 100);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tasks-panel">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-foreground">Tasks</span>
          <span className="text-muted-foreground" data-testid="tasks-panel-progress">
            {model.completed}/{model.total} done
          </span>
        </div>
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={model.total}
          aria-valuenow={model.completed}
          aria-label="Tasks completed"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
        {model.explanation ? (
          <p className="mt-2 text-muted-foreground text-xs">{model.explanation}</p>
        ) : null}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto p-2">
        {model.steps.map((step) => {
          const duration = formatStepDuration(step.durationMs);
          return (
            <li
              key={step.id}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
              data-status={step.status}
              data-testid="tasks-panel-step"
            >
              <span className="mt-0.5 shrink-0" role="img" aria-label={STATUS_LABEL[step.status]}>
                {step.status === "completed" ? (
                  <CheckCircle2Icon className="size-4 text-success" />
                ) : step.status === "running" ? (
                  <LoaderCircleIcon className="size-4 animate-spin text-primary" />
                ) : (
                  <CircleIcon className="size-4 text-muted-foreground/70" />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 whitespace-pre-wrap break-words",
                  step.status === "completed" && "text-muted-foreground line-through",
                  step.status === "running" && "font-medium text-foreground",
                )}
              >
                {step.text}
              </span>
              {duration ? (
                <span className="mt-0.5 shrink-0 text-muted-foreground text-xs tabular-nums">
                  {duration}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
});

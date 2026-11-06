import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";
import { CONTEXT_BREAKDOWN_LABELS, type ContextBreakdown } from "~/lib/contextBreakdown";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  breakdown?: ContextBreakdown | null | undefined;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, breakdown, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } =
    props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {breakdown ? (
            <ContextBreakdownView usage={usage} breakdown={breakdown} />
          ) : usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}

const SEGMENT_COLORS = {
  messages: "#3b78d8",
  system: "#e5793e",
  reasoning: "#4fb08f",
  skills: "#8a8a8a",
  buffer: "#c4c4c4",
  free: "#ebebeb",
} as const;

function formatSharePercentage(tokens: number, maxTokens: number): string {
  const value = (tokens / maxTokens) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** A stacked bar plus legend: what fills the window, the autocompact reserve, and free space. */
function ContextBreakdownView(props: {
  usage: ContextWindowSnapshot;
  breakdown: ContextBreakdown;
}) {
  const { usage, breakdown } = props;
  const maxTokens = usage.maxTokens ?? null;
  const bufferTokens =
    maxTokens !== null && usage.autoCompactThreshold != null
      ? Math.max(0, maxTokens - usage.autoCompactThreshold)
      : 0;
  const freeTokens =
    maxTokens !== null ? Math.max(0, maxTokens - usage.usedTokens - bufferTokens) : 0;
  const rows = [
    ...[...breakdown.categories]
      .filter((row) => row.tokens > 0)
      .toSorted((left, right) => right.tokens - left.tokens)
      .map((row) => ({
        key: row.category as string,
        label: CONTEXT_BREAKDOWN_LABELS[row.category],
        tokens: row.tokens,
        color: SEGMENT_COLORS[row.category] as string,
        approximate: breakdown.estimated,
      })),
    ...(bufferTokens > 0
      ? [
          {
            key: "buffer",
            label: "Autocompact buffer",
            tokens: bufferTokens,
            color: SEGMENT_COLORS.buffer as string,
            approximate: false,
          },
        ]
      : []),
    ...(maxTokens !== null
      ? [
          {
            key: "free",
            label: "Free space",
            tokens: freeTokens,
            color: SEGMENT_COLORS.free as string,
            approximate: false,
          },
        ]
      : []),
  ];
  const barTotal = maxTokens ?? Math.max(1, usage.usedTokens);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40"
        role="img"
        aria-label="Context window breakdown"
      >
        {rows.map((row) =>
          row.tokens > 0 ? (
            <div
              key={row.key}
              style={{ width: `${(row.tokens / barTotal) * 100}%`, backgroundColor: row.color }}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-2xs leading-4">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-xs"
              style={{ backgroundColor: row.color }}
            />
            <span className="flex-1 text-secondary-label">{row.label}</span>
            <span className="tabular-nums text-secondary-label">
              {row.approximate ? "~" : ""}
              {formatContextWindowTokens(row.tokens)}
            </span>
            {maxTokens !== null ? (
              <span className="w-10 text-right font-medium tabular-nums text-secondary-label">
                {formatSharePercentage(row.tokens, maxTokens)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, type FormEvent } from "react";

import { type SlowRpcAckRequest, subscribeSlowRpcAckRequests } from "../rpc/requestLatencyState";
import {
  DEFAULT_SLOW_REQUEST_PAUSE_HOURS,
  MAX_SLOW_REQUEST_PAUSE_HOURS,
  MIN_SLOW_REQUEST_PAUSE_HOURS,
  isSlowRequestWarningsPaused,
  parseSlowRequestPauseHoursInput,
  pauseSlowRequestWarningsForHours,
  pauseSlowRequestWarningsForever,
  readSlowRequestWarningsPause,
  subscribeSlowRequestWarningsPause,
} from "./SlowRpcRequestToastCoordinator.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

function SlowRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((request) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={request.requestId}
        >
          <div className="wrap-break-word font-medium text-foreground">{request.tag}</div>
          <div className="mt-0.5 text-3xs opacity-75">
            Started {new Date(request.startedAt).toLocaleTimeString()}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SlowRequestPauseControls() {
  const [hoursInput, setHoursInput] = useState(String(DEFAULT_SLOW_REQUEST_PAUSE_HOURS));
  const parsedHours = parseSlowRequestPauseHoursInput(hoursInput);
  const isInvalid = parsedHours === null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (parsedHours === null) {
      return;
    }
    setHoursInput(String(parsedHours));
    pauseSlowRequestWarningsForHours(parsedHours);
  };

  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-1">
        <Input
          aria-invalid={isInvalid || undefined}
          aria-label="Pause hours"
          className="w-12 select-text"
          font="mono"
          inputMode="numeric"
          max={MAX_SLOW_REQUEST_PAUSE_HOURS}
          min={MIN_SLOW_REQUEST_PAUSE_HOURS}
          nativeInput
          onBlur={() => {
            if (parsedHours !== null) {
              setHoursInput(String(parsedHours));
            }
          }}
          onChange={(event) => setHoursInput(event.currentTarget.value)}
          size="compact"
          step={1}
          type="number"
          value={hoursInput}
        />
        <span className="text-xs text-muted-foreground">hr</span>
      </div>
      <Button disabled={isInvalid} size="xs" type="submit" variant="outline">
        Pause
      </Button>
      <Button
        onClick={() => pauseSlowRequestWarningsForever()}
        size="xs"
        type="button"
        variant="ghost-muted"
      >
        Forever
      </Button>
    </form>
  );
}

/** One warning toast that tracks the set of slow requests while any are outstanding. */
export function startSlowRpcRequestToasts(): () => void {
  let toastId: ReturnType<typeof toastManager.add> | null = null;
  let latestSlowRequests: ReadonlyArray<SlowRpcAckRequest> = [];

  const closeActiveToast = () => {
    if (toastId !== null) {
      toastManager.close(toastId);
      toastId = null;
    }
  };

  const syncToast = () => {
    if (
      latestSlowRequests.length === 0 ||
      isSlowRequestWarningsPaused(readSlowRequestWarningsPause())
    ) {
      closeActiveToast();
      return;
    }

    const nextToast = {
      data: {
        expandableContent: <SlowRequestDetails requests={latestSlowRequests} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
        footerContent: <SlowRequestPauseControls />,
      },
      description: describeSlowRequests(latestSlowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };

    if (toastId === null) {
      toastId = toastManager.add(nextToast);
    } else {
      toastManager.update(toastId, nextToast);
    }
  };

  const unsubscribeRequests = subscribeSlowRpcAckRequests((slowRequests) => {
    latestSlowRequests = slowRequests;
    syncToast();
  });
  const unsubscribePause = subscribeSlowRequestWarningsPause(syncToast);

  return () => {
    unsubscribeRequests();
    unsubscribePause();
    closeActiveToast();
  };
}

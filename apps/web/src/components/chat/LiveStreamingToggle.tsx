import type { EnvironmentId } from "@t3tools/contracts";
import { ZapIcon, ZapOffIcon } from "lucide-react";
import { memo } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/**
 * Fork: composer button that turns live streaming of reasoning and responses on or off.
 * The setting is server-wide (liveStreaming) and persists; the server reads it per event,
 * so a click applies to the run in progress.
 */
export const LiveStreamingToggle = memo(function LiveStreamingToggle(props: {
  environmentId: EnvironmentId;
}) {
  const live = useEnvironmentSettings(props.environmentId, (settings) => settings.liveStreaming);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const label = live
    ? "Live streaming is on. Click to show text only when paragraphs finish"
    : "Live streaming is off. Click to stream reasoning and responses as they arrive";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            aria-pressed={live}
            aria-label={label}
            data-testid="live-streaming-toggle"
            onClick={() => updateSettings({ liveStreaming: !live })}
          />
        }
      >
        <ComposerControlIcon
          icon={live ? ZapIcon : ZapOffIcon}
          size="xs"
          className={live ? "text-current opacity-100" : undefined}
        />
        <span className="sr-only">Live streaming</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});

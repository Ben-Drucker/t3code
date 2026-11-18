// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native modifier-key poller with Node.

import * as NodeChildProcess from "node:child_process";

import type { SnapShotModifier } from "@t3tools/contracts";

const MAC_MODIFIER_PAIR_DEVICE_MASKS: Record<SnapShotModifier, readonly [number, number]> = {
  shift: [0x2, 0x4],
  control: [0x1, 0x2000],
  alt: [0x20, 0x40],
  meta: [0x8, 0x10],
};

// CoreGraphics registers osascript as a foreground app; go background-only first to avoid a Dock tile.
const POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const left = Number(argv[0]);
  const right = Number(argv[1]);
  const both = left | right;
  const doubleTap = argv[2] === "double-tap";
  let pressedAt = 0;
  let lastTap = 0;
  let previousKeyDowns = Number($.CGEventSourceCounterForEventType(0, 10));
  let active = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const flags = $.CGEventSourceFlagsState(0);
    if (!doubleTap) {
      const pressed = (flags & both) === both;
      if (pressed && !active) console.log("trigger");
      active = pressed;
    } else {
      const now = Date.now();
      const keyDowns = Number($.CGEventSourceCounterForEventType(0, 10));
      const modifierFlags = flags & 0x1e0000;
      const optionOnly = modifierFlags === 0x80000 && (flags & both) !== both;
      if (keyDowns !== previousKeyDowns || (modifierFlags !== 0 && !optionOnly)) {
        lastTap = 0;
        pressedAt = 0;
      } else if (optionOnly && !active) {
        pressedAt = now;
      } else if (!optionOnly && active) {
        if (pressedAt === 0 || now - pressedAt > 225) {
          lastTap = 0;
        } else if (lastTap !== 0 && now - lastTap <= 400) {
          console.log("trigger");
          lastTap = 0;
        } else {
          lastTap = now;
        }
        pressedAt = 0;
      }
      previousKeyDowns = keyDowns;
      active = optionOnly;
    }
    delay(doubleTap ? 0.025 : 0.05);
  }
  return "orphaned";
}`;

export function startMacModifierPairShortcutProcess(
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
  mode: "pair" | "double-tap" = "pair",
): Promise<() => void> {
  const [left, right] = MAC_MODIFIER_PAIR_DEVICE_MASKS[modifier];
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT, String(left), String(right), mode],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      poller.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        if (message !== "trigger" || !settled || stopped) continue;
        try {
          onTrigger();
        } catch {}
      }
    });
    poller.once("error", (error) => {
      fail(error);
    });
    poller.once("exit", (code) => {
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}

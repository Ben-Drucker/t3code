import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";

it("renders an animated non-interactive rim when working and omits it when idle", async () => {
  await using idleScreen = await render(
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main working={false}>
          <div>Idle</div>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>,
  );
  expect(idleScreen.container.querySelector('[data-slot="composer-working-rim"]')).toBeNull();

  await using workingScreen = await render(
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <ComposerSurface.Main working className="ultrathink-frame">
          <div>Running</div>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>,
  );
  const rim = workingScreen.container.querySelector('[data-slot="composer-working-rim"]');
  expect(rim).not.toBeNull();
  const style = getComputedStyle(rim!);
  expect(style.display).not.toBe("none");
  expect(style.position).toBe("absolute");
  expect(style.pointerEvents).toBe("none");
  expect(style.animationName).toBe("composer-working-rim-pulse");
});

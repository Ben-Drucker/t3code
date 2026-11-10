// @effect-diagnostics globalDate:off -- The BiDi Promise adapter bounds native callback waits with a wall-clock deadline.
import type {
  PreviewAutomationAutofillInput,
  PreviewAutomationAutofillResult,
} from "@t3tools/contracts";
import type { FirefoxBidi } from "./FirefoxBidi.ts";
import {
  bannerScreenPoint,
  selectAutofillEntry,
  type AutofillEntry,
  type Point,
  type Rect,
} from "./FirefoxAutofillGeometry.ts";

interface Tree {
  context: string;
  url: string;
  children?: Tree[] | null;
}
interface Remote {
  type: string;
  value?: unknown;
}
const flatten = (trees: Tree[]): Tree[] =>
  trees.flatMap((tree) => [tree, ...flatten(tree.children ?? [])]);
const originOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
};
function deserialize(remote: Remote): unknown {
  if (remote.type === "object")
    return Object.fromEntries(
      (remote.value as Array<[string, Remote]>).map(([key, value]) => [key, deserialize(value)]),
    );
  if (remote.type === "array") return (remote.value as Remote[]).map(deserialize);
  return remote.type === "null" || remote.type === "undefined" ? null : remote.value;
}

// Read only rendered entry labels. Form values and credential/code elements are never inspected.
const ENTRIES = `(() => {
  const safe = el => !el.closest('input,textarea,[type=password],[autocomplete=one-time-code],[data-testid*=password],[data-testid*=otp],[data-testid*=code],[aria-label*=password i],[aria-label*=code i]');
  const entries = [...document.querySelectorAll('#root div[role=button],#root [role=option]')].filter(el=>el.getBoundingClientRect().width>0);
  return entries.map((el,index)=>{
    const lines = [...el.querySelectorAll('span')].filter(span=>!span.querySelector('span') && safe(span)).slice(0,2).map(span=>span.textContent.trim());
    return {index,title:(lines[0]||'').slice(0,256),username:(lines[1]||'').slice(0,320)};
  }).filter(entry=>entry.title && entry.username);
})()`;

export interface AutofillOptions {
  readonly click: (pid: number, target: () => Promise<Point>) => Promise<void>;
  readonly supported: boolean;
  /** Isolated fixture origins only; production accepts extension contexts exclusively. */
  readonly bannerOrigin?: string;
}

export async function autofillFirefox(
  bidi: FirefoxBidi,
  context: string,
  pid: number,
  input: PreviewAutomationAutofillInput,
  options: AutofillOptions,
  frames: () => Promise<Array<{ url: string; rect: Rect }>>,
): Promise<PreviewAutomationAutofillResult> {
  const evaluate = async <A>(target: string, expression: string): Promise<A> => {
    const response = (await bidi.command("script.evaluate", {
      target: { context: target },
      expression,
      awaitPromise: true,
      resultOwnership: "none",
    })) as { type: string; result: Remote };
    if (response.type !== "success") throw new Error("Could not inspect the 1Password banner.");
    return deserialize(response.result) as A;
  };
  const url = () => evaluate<string>(context, "location.href");
  const original = await url();
  let bannerFound = false;
  let chosenLabels: { title: string; username: string } | null = null;
  const accepted = (candidate: Tree) =>
    candidate.url.startsWith("moz-extension://") ||
    (options.bannerOrigin !== undefined && candidate.url.startsWith(options.bannerOrigin + "/"));
  const find = async () => {
    const tree = (await bidi.command("browsingContext.getTree", { root: context })) as {
      contexts: Tree[];
    };
    const sources = await frames();
    const candidates = flatten(tree.contexts).filter(
      (candidate) =>
        accepted(candidate) &&
        sources.some((frame) => originOf(frame.url) === originOf(candidate.url)),
    );
    for (const candidate of candidates) {
      const valid = await evaluate<boolean>(
        candidate.context,
        "!!document.querySelector('#root')",
      ).catch(() => false);
      if (valid) return candidate;
    }
    return undefined;
  };
  await bidi.command("session.subscribe", {
    events: ["browsingContext.contextCreated", "browsingContext.domContentLoaded"],
  });
  const changes = bidi.changes();
  const deadline = Date.now() + 5_000;
  try {
    const located = (await bidi.command("browsingContext.locateNodes", {
      context,
      locator: {
        type: "css",
        value:
          "input[autocomplete=username],input[type=email],input[name=login],input[name=username],input#login_field",
      },
    })) as { nodes: Array<{ sharedId: string }> };
    if (!located.nodes[0])
      return {
        bannerFound: false,
        selected: null,
        url: await url(),
        outcome: (await url()) !== original ? "redirected" : "banner-unavailable",
      };
    await bidi.command("input.performActions", {
      context,
      actions: [
        {
          type: "pointer",
          id: "autofill-focus",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: 0,
              y: 0,
              origin: { type: "element", element: { sharedId: located.nodes[0].sharedId } },
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    let banner = await find();
    while (
      !banner &&
      Date.now() < deadline &&
      (await changes.next(Math.max(1, deadline - Date.now())))
    ) {
      if ((await url()) !== original)
        return { bannerFound: false, selected: null, url: await url(), outcome: "redirected" };
      banner = await find();
    }
    if (!banner)
      return {
        bannerFound: false,
        selected: null,
        url: await url(),
        outcome: (await url()) !== original ? "redirected" : "banner-unavailable",
      };
    const bannerContext = banner.context;
    bannerFound = true;
    const clickLabel = async (expression: string) =>
      options.click(pid, async () => {
        if ((await url()) !== original)
          throw new Error("The login page redirected before the autofill click.");
        const label = await evaluate<{ rect: Rect; width: number; height: number }>(
          bannerContext,
          `(() => { const el = ${expression}; if(!el) throw Error('No banner target'); const r=el.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},width:innerWidth,height:innerHeight}; })()`,
        );
        const page = await evaluate<{
          screen: Point;
          viewport: { width: number; height: number };
        }>(
          context,
          `(() => {
        if(document.visibilityState!=='visible')throw Error('The login tab is no longer visible');
        return {screen:{x:mozInnerScreenX,y:mozInnerScreenY},viewport:{width:innerWidth,height:innerHeight}};
      })()`,
        );
        const matching = (await frames())
          .filter((frame) => originOf(frame.url) === originOf(banner.url))
          .map((frame) => frame.rect)
          .filter((frame) => frame.width > 0 && frame.height > 0);
        if (matching.length !== 1)
          throw new Error(
            "Cannot uniquely measure the 1Password iframe. Open the banner in Firefox and retry.",
          );
        return bannerScreenPoint({
          ...page,
          frame: matching[0]!,
          banner: { width: label.width, height: label.height },
          label: label.rect,
        });
      });
    let entries = await evaluate<AutofillEntry[]>(bannerContext, ENTRIES);
    let selected = selectAutofillEntry(entries, input);
    if (!selected) {
      const other =
        "[...document.querySelectorAll('#root span')].find(el=>!el.closest('[role=button],[role=option]') && !el.querySelector('span') && el.textContent.trim()==='Other logins')";
      if (await evaluate<boolean>(bannerContext, `!!(${other})`)) {
        await clickLabel(other);
        const ready = await evaluate<boolean>(
          bannerContext,
          `new Promise(resolve=>{const ready=()=>!!document.querySelector('#root [role=option]');if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve(true);}});const timer=setTimeout(()=>{observer.disconnect();resolve(false);},4000);observer.observe(document,{childList:true,subtree:true});})`,
        );
        if (!ready) throw new Error("1Password did not open Other logins.");
        entries = await evaluate<AutofillEntry[]>(bannerContext, ENTRIES);
        selected = selectAutofillEntry(entries, input);
      }
    }
    if (!selected) throw new Error("No 1Password entry matches that exact username and title.");
    const chosen = selected;
    chosenLabels = { title: chosen.title, username: chosen.username };
    // Resolve again after the warning; a changed list must never select a different login.
    const target = `(() => { const entries=${ENTRIES};const matching=entries.filter(entry=>entry.title===${JSON.stringify(chosen.title)} && entry.username===${JSON.stringify(chosen.username)});if(matching.length!==1)return null;const entry=matching[0];const cards=[...document.querySelectorAll('#root div[role=button],#root [role=option]')].filter(el=>el.getBoundingClientRect().width>0);const card=cards[entry.index];const label=[...card.querySelectorAll('span')].filter(el=>!el.querySelector('span')).at(-1);return (label && label.textContent.trim()==='Sign in'?label:null) || (card.getAttribute('role')==='option'?card:null);})()`;
    const choosesEntry = await evaluate<boolean>(
      bannerContext,
      `(${target})?.getAttribute('role')==='option'`,
    );
    if (choosesEntry) {
      await clickLabel(target);
      const ready = await evaluate<boolean>(
        bannerContext,
        `new Promise(resolve=>{const ready=()=>{const target=${target};return target && target.getAttribute('role')!=='option';};if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve(true);}});const timer=setTimeout(()=>{observer.disconnect();resolve(false);},4000);observer.observe(document,{childList:true,subtree:true});})`,
      );
      if (!ready) throw new Error("1Password did not show Sign in for the chosen entry.");
    }
    await clickLabel(target);
    const after = await url();
    return {
      bannerFound: true,
      selected: { title: chosen.title, username: chosen.username },
      url: after,
      outcome: after !== original ? "redirected" : "clicked",
    };
  } catch (cause) {
    const after = await url().catch(() => original);
    if (after !== original)
      return { bannerFound, selected: chosenLabels, url: after, outcome: "redirected" };
    throw cause;
  } finally {
    changes.close();
    await bidi.command("input.releaseActions", { context }).catch(() => undefined);
    await bidi
      .command("session.unsubscribe", {
        events: ["browsingContext.contextCreated", "browsingContext.domContentLoaded"],
      })
      .catch(() => undefined);
  }
}

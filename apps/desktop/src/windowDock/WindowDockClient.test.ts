import { assert, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off -- Fakes the helper process with Node streams.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { startWindowDockClient, type WindowDockSpawn } from "./WindowDockClient.ts";

function fakeHelper() {
  const stdout = new NodeStream.PassThrough();
  const written: Array<Record<string, unknown>> = [];
  const waiters: Array<{ matches: () => boolean; resolve: () => void }> = [];
  let blocked = false;
  const stdin = new NodeStream.Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      written.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      for (const waiter of waiters.splice(0)) {
        if (waiter.matches()) waiter.resolve();
        else waiters.push(waiter);
      }
      if (blocked) held.push(callback);
      else callback();
    },
  });
  const held: Array<() => void> = [];
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin,
    stdout,
    kill: () => true,
  });
  return {
    spawn: (() => child) as unknown as WindowDockSpawn,
    written,
    until: (matches: () => boolean) =>
      new Promise<void>((resolve) => {
        if (matches()) resolve();
        else waiters.push({ matches, resolve });
      }),
    reply: (message: object) => stdout.write(`${JSON.stringify(message)}\n`),
    child,
    block: () => {
      blocked = true;
    },
    release: () => {
      blocked = false;
      for (const callback of held.splice(0)) callback();
    },
  };
}

it("matches replies to requests by id and parses find results", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  const trusted = client.checkTrusted(false);
  await helper.until(() => helper.written.length === 1);
  assert.deepStrictEqual(helper.written[0], { type: "check", prompt: false, id: 1 });
  helper.reply({ type: "result", id: 1, trusted: true });
  assert.isTrue(await trusted);

  const found = client.find(42);
  await helper.until(() => helper.written.length === 2);
  helper.reply({
    type: "result",
    id: 2,
    found: true,
    frame: { x: 1, y: 2, width: 3, height: 4 },
    contentTop: 88,
  });
  assert.deepStrictEqual(await found, {
    found: true,
    frame: { x: 1, y: 2, width: 3, height: 4 },
    contentTop: 88,
  });
});

it("reports closed events and ignores malformed lines", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  const closed: number[] = [];
  client.onClosed((pid) => closed.push(pid));
  const seen = new Promise<void>((resolve) => client.onClosed(() => resolve()));
  helper.child.stdout.write("not json\n");
  helper.reply({ type: "closed", pid: 7 });
  await seen;
  assert.deepStrictEqual(closed, [7]);
});

it("drops stale frames while the helper pipe is backed up", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  helper.block();
  for (let x = 0; x < 20; x++) client.setFrame(5, { x, y: 0, width: 100, height: 100 });
  helper.release();
  await helper.until(() => helper.written.some((message) => message.x === 19));
  const frames = helper.written.filter((message) => message.type === "setFrame");
  assert.isBelow(frames.length, 20);
  assert.strictEqual(frames.at(-1)?.x, 19);
});

it("fails pending requests when the helper exits", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  const trusted = client.checkTrusted(true);
  helper.child.emit("exit", 1);
  assert.isFalse(await trusted);
  assert.isFalse(client.alive());
});

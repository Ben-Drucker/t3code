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

it("matches replies to requests by id and parses candidate windows", async () => {
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
    windows: [
      {
        windowId: 7,
        pid: 42,
        standard: true,
        minimized: false,
        frame: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
    contentTop: 88,
  });
  assert.deepStrictEqual(await found, {
    found: true,
    windows: [
      {
        windowId: 7,
        pid: 42,
        standard: true,
        minimized: false,
        frame: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
    contentTop: 88,
  });
});

it("reports closed and frameChanged events with windowId and ignores malformed lines", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  const closed: Array<{ pid: number; windowId: number | undefined }> = [];
  const frames: Array<{ pid: number; windowId: number; frame: { width: number } }> = [];
  client.onClosed((event) => closed.push(event));
  client.onFrameChanged((event) => frames.push(event));
  const seen = new Promise<void>((resolve) => client.onClosed(() => resolve()));
  helper.child.stdout.write("not json\n");
  helper.reply({
    type: "frameChanged",
    pid: 7,
    windowId: 3,
    frame: { x: 10, y: 20, width: 800, height: 600 },
  });
  helper.reply({ type: "closed", pid: 7, windowId: 3 });
  await seen;
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0]?.windowId, 3);
  assert.strictEqual(frames[0]?.frame.width, 800);
  assert.deepStrictEqual(closed, [{ pid: 7, windowId: 3 }]);
});

it("drops stale frames while the helper pipe is backed up", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  helper.block();
  for (let x = 0; x < 20; x++) client.setFrame(5, 11, { x, y: 0, width: 100, height: 100 });
  helper.release();
  await helper.until(() => helper.written.some((message) => message.x === 19));
  const frames = helper.written.filter((message) => message.type === "setFrame");
  assert.isBelow(frames.length, 20);
  assert.strictEqual(frames.at(-1)?.x, 19);
  assert.strictEqual(frames.at(-1)?.windowId, 11);
});

it("fails pending requests when the helper exits", async () => {
  const helper = fakeHelper();
  const client = startWindowDockClient("fake", helper.spawn);
  const trusted = client.checkTrusted(true);
  helper.child.emit("exit", 1);
  assert.isFalse(await trusted);
  assert.isFalse(client.alive());
});

import {
  PiToolChoices,
  PiToolsSnapshot,
  type PiToolsInput,
  type PiToolsSetChoicesInput,
} from "@t3tools/contracts";
import { piToolsFiles } from "@t3tools/provider-pi/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const ToolsFile = Schema.fromJsonString(Schema.Struct({ tools: PiToolsSnapshot.fields.tools }));
const ChoicesFile = Schema.fromJsonString(PiToolChoices);
const decodeTools = Schema.decodeUnknownEffect(ToolsFile);
const decodeChoices = Schema.decodeUnknownEffect(ChoicesFile);
const encodeChoices = Schema.encodeEffect(ChoicesFile);

const readText = Effect.fn("PiTools.readText")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(file);
});

const readDecoded = <A, E>(file: string, decode: (text: string) => Effect.Effect<A, E>) =>
  readText(file).pipe(
    Effect.flatMap(decode),
    Effect.orElseSucceed((): A | undefined => undefined),
  );

/** What T3's Pi extension reported for the thread, with the choices it will apply next turn. */
export const get = Effect.fn("PiTools.get")(function* (input: PiToolsInput) {
  const config = yield* ServerConfig.ServerConfig;
  const files = piToolsFiles(config.providerStatusCacheDir, input.threadId);
  const report = yield* readDecoded(files.tools, decodeTools);
  const choices =
    (yield* readDecoded(files.choices, decodeChoices)) ??
    (yield* readDecoded(files.defaultChoices, decodeChoices)) ??
    {};
  return { tools: report?.tools ?? [], choices };
});

/** Saved for the thread and as the default for threads without their own. */
export const setChoices = Effect.fn("PiTools.setChoices")(function* (
  input: PiToolsSetChoicesInput,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const files = piToolsFiles(config.providerStatusCacheDir, input.threadId);
  const text = yield* encodeChoices(input.choices).pipe(Effect.orDie);
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(files.dir, { recursive: true });
    for (const file of [files.choices, files.defaultChoices]) {
      const staging = `${file}.${process.pid}.tmp`;
      yield* fileSystem.writeFileString(staging, text);
      yield* fileSystem.rename(staging, file);
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Could not save Pi tool choices", { cause })));
});

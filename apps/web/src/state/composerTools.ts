import { createComposerToolsEnvironmentAtoms } from "@t3tools/client-runtime/state/composer-tools";

import { connectionAtomRuntime } from "../connection/runtime";

export const composerToolsEnvironment = createComposerToolsEnvironmentAtoms(connectionAtomRuntime);

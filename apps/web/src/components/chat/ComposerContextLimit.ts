import { createContext, useContext } from "react";

/** The thread's current context limit in tokens, so pickers can show what a choice leaves free. */
const ComposerContextLimitContext = createContext<number | null>(null);

export const ComposerContextLimitProvider = ComposerContextLimitContext.Provider;
export const useComposerContextLimit = () => useContext(ComposerContextLimitContext);

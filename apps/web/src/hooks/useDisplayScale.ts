import { useSyncExternalStore } from "react";

function subscribe(notify: () => void) {
  let query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const change = () => {
    query.removeEventListener("change", change);
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", change);
    notify();
  };
  query.addEventListener("change", change);
  window.addEventListener("resize", change);
  return () => {
    query.removeEventListener("change", change);
    window.removeEventListener("resize", change);
  };
}
export function useDisplayScale() {
  return useSyncExternalStore(
    subscribe,
    () => window.devicePixelRatio || 1,
    () => 1,
  );
}

import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export function DesktopMiniQqMainCoordinator() {
  const router = useRouter();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the main desktop shell as ready to receive promoted Quick Question routes and handles incoming route navigation
  useEffect(() => {
    const miniQq = window.desktopBridge?.miniQq;
    if (!miniQq) return;

    const unsubscribe = miniQq.onOpenRoute((routePath) => {
      if (!routePath.startsWith("/")) return;
      void router.navigate({ href: routePath });
    });
    void miniQq.setMainReady(true);

    return () => {
      unsubscribe();
      void miniQq.setMainReady(false);
    };
  }, [router]);

  return null;
}

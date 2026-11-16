import type { ReactNode } from "react";

export const APP_BOOT_RECOVERY_HANDOFF_EVENT = "keiko:workspace-ownership-started";

/** Static first paint shared by both boot boundaries and the pre-hydration recovery watchdog. */
export function AppBootPlaceholder(): ReactNode {
  return (
    <div className="app" aria-hidden="true">
      <div className="app-boot">
        {/* eslint-disable-next-line @next/next/no-img-element -- the boot shell must render before any client bundle and use the existing recovery markup. */}
        <img className="app-boot-logo" src="/keiko-logo.svg" alt="" />
      </div>
    </div>
  );
}

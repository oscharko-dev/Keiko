"use client";

// The shell-level error boundary. AppShellInner had NO boundary above it: any render-time throw
// unmounted the whole desktop to a blank page, and when the throw came from persisted state — a
// keybinding override the shell refused at render time — it came back on every load with no
// in-product affordance to undo it. A blank page cannot be recovered from; this surface can: it
// names what happened and offers the reset for the persisted setting that causes it.
//
// Mirrors WindowBodyBoundary (the repo's per-window boundary): class component,
// getDerivedStateFromError, a fallback with zero heavy dependencies. It renders inside I18nProvider
// but above TwinProvider and the shell, so every string still goes through the i18n API.

import { Component, type ReactNode } from "react";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { resetPersistedShortcutOverrides } from "./shellRecovery";
import styles from "./AppShellBoundary.module.css";

interface AppShellBoundaryProps {
  readonly children: ReactNode;
  // Seam for the tests: the real recovery talks to the settings API and then reloads.
  readonly resetPersistedState?: () => Promise<void>;
  readonly reload?: () => void;
}

interface InnerAppShellBoundaryProps extends AppShellBoundaryProps {
  readonly t: I18nTranslate;
}

type RecoveryState = "idle" | "running" | "failed";

interface AppShellBoundaryState {
  readonly failed: boolean;
  readonly recovery: RecoveryState;
}

class InnerAppShellBoundary extends Component<InnerAppShellBoundaryProps, AppShellBoundaryState> {
  public override state: AppShellBoundaryState = { failed: false, recovery: "idle" };

  public static getDerivedStateFromError(): AppShellBoundaryState {
    return { failed: true, recovery: "idle" };
  }

  public override componentDidCatch(error: Error): void {
    // Same observable-not-silent idiom as WindowBodyBoundary: the crash must stay diagnosable from
    // the console even though the UI only shows the recovery surface.
    console.warn("[keiko] app shell crashed", error);
  }

  private readonly reload = (): void => {
    (this.props.reload ?? ((): void => window.location.reload()))();
  };

  private readonly resetAndReload = (): void => {
    const reset = this.props.resetPersistedState ?? resetPersistedShortcutOverrides;
    this.setState({ failed: true, recovery: "running" });
    reset().then(
      (): void => this.reload(),
      (): void => this.setState({ failed: true, recovery: "failed" }),
    );
  };

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const t = this.props.t;
    return (
      <div className={styles.surface} data-app-shell-crashed="true">
        <div className={styles.panel} role="alert">
          <p className={styles.title}>{t("shell.error.title")}</p>
          <p className={styles.body}>{t("shell.error.body")}</p>
          <p className={styles.hint}>{t("shell.error.hint")}</p>
          {this.state.recovery === "failed" ? (
            <p className={styles.failure}>{t("shell.error.resetFailed")}</p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              disabled={this.state.recovery === "running"}
              onClick={this.resetAndReload}
            >
              {t("shell.error.resetShortcuts")}
            </button>
            <button type="button" className={styles.action} onClick={this.reload}>
              {t("shell.error.reload")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export function AppShellBoundary(props: AppShellBoundaryProps): ReactNode {
  const t = useTranslate();
  return <InnerAppShellBoundary {...props} t={t} />;
}

"use client";

// GEN-STAB-WINDOW-001 — per-window error boundary. The canvas mounts every open window's
// widget body with NO enclosing boundary: one render throw inside any widget (a malformed
// message, a bad persisted cfg, a defect in a lazily-loaded chunk) unmounted the whole
// canvas to a white screen, taking every other window's state with it. This boundary
// contains the failure to the one window body: the frame chrome (close/minimize buttons,
// drag, z-order) stays alive, sibling windows keep rendering/streaming, and the user can
// retry the body or close just that window.
//
// Mirrors SafeMarkdownBoundary (the repo's per-message boundary): class component,
// getDerivedStateFromError, minimal fallback with zero heavy dependencies. The fallback
// reuses the existing global lk-empty/lk-btn classes — globals.css is SHA-gated (#1300)
// and must not grow for this.

import { Component, type ReactNode } from "react";

interface WindowBodyBoundaryProps {
  // Window TYPE (registry key), not the user-supplied title: the type is the only value
  // this boundary logs, and titles can carry user content (e.g. chat names).
  readonly windowType: string;
  readonly children: ReactNode;
}

interface WindowBodyBoundaryState {
  readonly failed: boolean;
}

export class WindowBodyBoundary extends Component<
  WindowBodyBoundaryProps,
  WindowBodyBoundaryState
> {
  public override state: WindowBodyBoundaryState = { failed: false };

  public static getDerivedStateFromError(): WindowBodyBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error): void {
    // Same observable-not-silent idiom as AppShell's connected-scope warn: the crash must
    // be diagnosable from the console, keyed by window type so it can be attributed.
    console.warn("[keiko] window body crashed", this.props.windowType, error);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="lk-empty" role="alert" data-window-body-crashed="true">
        <p className="lk-empty-title">This window hit an error</p>
        <p className="lk-empty-body">
          The window content crashed while rendering. Other windows are unaffected — retry the
          content or close this window.
        </p>
        <button type="button" className="lk-btn lk-btn-ghost" onClick={this.retry}>
          Retry
        </button>
      </div>
    );
  }
}

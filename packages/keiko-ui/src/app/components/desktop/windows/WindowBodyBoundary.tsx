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
//
// #4103 F1: a window whose lazily loaded chunk cannot load (most often a tab that outlived a server
// upgrade, so the new build no longer ships the old chunk) cannot recover by re-rendering — the
// bundler keeps the failed request. That failure is told apart, reported as `unavailable` rather
// than `internal`, and offers the page reload that requests the current build; the workspace
// restores every window after it.

import { SupportReportButton } from "../SupportReportButton";
import { clientErrorEvidence, isChunkLoadFailure } from "@/lib/client-error-evidence";
import { Component, type ReactNode } from "react";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

interface WindowBodyBoundaryProps {
  // Window TYPE (registry key), not the user-supplied title: the type is the only value
  // this boundary logs, and titles can carry user content (e.g. chat names).
  readonly windowType: string;
  readonly children: ReactNode;
  // Seam for the tests: the real recovery reloads the page.
  readonly reload?: (() => void) | undefined;
}

interface InnerWindowBodyBoundaryProps extends WindowBodyBoundaryProps {
  readonly t: I18nTranslate;
}

interface WindowBodyBoundaryState {
  readonly failed: boolean;
  readonly chunkLoadFailed?: boolean | undefined;
  readonly correlationId?: string | undefined;
}

class InnerWindowBodyBoundary extends Component<
  InnerWindowBodyBoundaryProps,
  WindowBodyBoundaryState
> {
  public override state: WindowBodyBoundaryState = { failed: false };

  public static getDerivedStateFromError(error: unknown): WindowBodyBoundaryState {
    return { failed: true, chunkLoadFailed: isChunkLoadFailure(error) };
  }

  public override componentDidCatch(error: Error): void {
    // Same observable-not-silent idiom as AppShell's connected-scope warn: the crash must
    // be diagnosable from the console, keyed by window type so it can be attributed.
    const correlationId = correlationIdOf(error) ?? crypto.randomUUID();
    this.setState({ correlationId });
    reportClientDiagnostic(
      `[keiko] window body crashed: ${this.props.windowType}: ${clientErrorSummary(error)}`,
      {
        correlationId,
        kind: "boundary",
        renderFailure: "window-body",
        errorKind: isChunkLoadFailure(error) ? "unavailable" : "internal",
        errorEvidence: clientErrorEvidence(error),
      },
    );
  }

  private readonly retry = (): void => {
    this.setState({ failed: false, chunkLoadFailed: false });
  };

  private readonly reload = (): void => {
    (this.props.reload ?? ((): void => window.location.reload()))();
  };

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.state.chunkLoadFailed === true) return this.renderChunkLoadFailure();
    return (
      <div className="lk-empty" role="alert" data-window-body-crashed="true">
        <p className="lk-empty-title">{this.props.t("window.error.title")}</p>
        <p className="lk-empty-body">{this.props.t("window.error.body")}</p>
        <button type="button" className="lk-btn lk-btn-ghost" onClick={this.retry}>
          {this.props.t("common.retry")}
        </button>
        <SupportReportButton correlationId={this.state.correlationId} />
      </div>
    );
  }

  private renderChunkLoadFailure(): ReactNode {
    return (
      <div className="lk-empty" role="alert" data-window-body-crashed="chunk-load">
        <p className="lk-empty-title">{this.props.t("window.error.chunkTitle")}</p>
        <p className="lk-empty-body">{this.props.t("window.error.chunkBody")}</p>
        <button type="button" className="lk-btn" onClick={this.reload}>
          {this.props.t("shell.error.reload")}
        </button>
        <SupportReportButton correlationId={this.state.correlationId} />
      </div>
    );
  }
}

export function WindowBodyBoundary(props: WindowBodyBoundaryProps): ReactNode {
  const t = useTranslate();
  return <InnerWindowBodyBoundary {...props} t={t} />;
}

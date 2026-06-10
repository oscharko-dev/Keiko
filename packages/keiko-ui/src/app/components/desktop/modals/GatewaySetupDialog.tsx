"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError, setupGateway } from "@/lib/api";
import { Icons } from "../Icons";

// Human-readable message first; the machine code (useful for support) is kept
// separate and rendered as a secondary mono line, never as a raw
// "CODE: message" prefix in the first-run flow (audit C191 — pattern:
// RelationshipCreateDialog / error-and-denial-ux.md).
function errorDetails(error: unknown): { readonly message: string; readonly code?: string } {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "The gateway could not be configured." };
}

function deploymentNamesFromInput(value: string): readonly string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function isAzureFoundryUrl(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

export function GatewaySetupDialog({
  onCancel,
}: {
  readonly onCancel?: (() => void) | undefined;
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState("");
  const [deploymentNames, setDeploymentNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    baseUrlRef.current?.focus();
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  const focusableInside = (root: HTMLElement): readonly HTMLElement[] => {
    const nodes = root.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
    );
    return Array.from(nodes);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const onDialogKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (busy || success !== undefined || onCancel === undefined) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableInside(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onDialogKeyDown);
    return () => dialog.removeEventListener("keydown", onDialogKeyDown);
  }, [busy, onCancel, success]);

  // After a failed test the controls are re-enabled but nothing was focused
  // (the disabled submit dropped focus to <body>, killing the Tab trap) —
  // return focus to the Base URL field so the user can correct directly
  // (audit C186/C084).
  useEffect(() => {
    if (error !== undefined && !busy) {
      baseUrlRef.current?.focus();
    }
  }, [error, busy]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    setSuccess(undefined);
    // All controls (incl. the focused submit) become disabled while testing,
    // which would drop focus to <body> and break the Tab trap — park focus on
    // the dialog container instead (audit C186).
    dialogRef.current?.focus();
    try {
      const parsedDeploymentNames = deploymentNamesFromInput(deploymentNames);
      if (isAzureFoundryUrl(baseUrl) && parsedDeploymentNames.length === 0) {
        setError(
          "Azure AI Foundry requires deployment names. Paste the names from the Deployments tab.",
        );
        setBusy(false);
        return;
      }
      const result = await setupGateway({
        baseUrl,
        apiKey,
        apiKeyHeaderName: apiKeyHeaderName.trim() === "" ? undefined : apiKeyHeaderName.trim(),
        deploymentNames: parsedDeploymentNames,
      });
      const count = result.testedModelIds.length;
      setSuccess(
        `Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"}. Reloading Keiko…`,
      );
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      const details = errorDetails(caught);
      setError(details.message);
      setErrorCode(details.code);
      setBusy(false);
    }
  }

  // Issue #422: when this dialog is opened from the Settings panel, its
  // ancestors include `.ws-scene`, which carries `will-change: transform` and
  // a CSS `zoom`. Both establish a containing block for `position: fixed`
  // descendants in Chromium, so the backdrop ends up sized to the zoomed
  // scene (which has zero intrinsic width/height) instead of the viewport.
  // Portalling to `document.body` makes the backdrop fixed to the viewport
  // regardless of where the dialog is mounted in the React tree.
  const dialogTree = (
    <div className="gw-setup-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="gw-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-setup-title"
        aria-describedby="gw-setup-desc"
        // tabIndex -1: keeps focus (and thus the Escape/Tab-trap keydown
        // listener on this element) inside the dialog when a non-focusable
        // area is clicked or all controls are disabled (audit C007/C186).
        tabIndex={-1}
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="gw-setup-badge">
            <Icons.cube size={18} />
            Model gateway setup
          </div>
          <h1 id="gw-setup-title">Connect Keiko to your internal LLMs</h1>
          <p id="gw-setup-desc">
            Keiko needs the internal gateway URL and API token before chat and agent workflows can
            run. The token is tested once and stored only on this machine.
          </p>
          <label className="gw-field">
            <span>Base URL</span>
            <input
              className="gw-input mono"
              value={baseUrl}
              placeholder="https://llm-gateway.example.com/v1"
              autoComplete="off"
              disabled={busy || success !== undefined}
              ref={baseUrlRef}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className="gw-field">
            <span>API token</span>
            <input
              className="gw-input mono"
              type="password"
              value={apiKey}
              placeholder="Paste your API token"
              autoComplete="off"
              disabled={busy || success !== undefined}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="gw-field">
            <span>
              API key header <span className="dlg-opt">optional</span>
            </span>
            <input
              className="gw-input mono"
              value={apiKeyHeaderName}
              placeholder="Authorization"
              autoComplete="off"
              disabled={busy || success !== undefined}
              onChange={(event) => setApiKeyHeaderName(event.target.value)}
            />
          </label>
          <label className="gw-field">
            <span>Deployment names for Azure</span>
            <textarea
              className="gw-input gw-textarea mono"
              value={deploymentNames}
              placeholder="Paste deployment names, one per line"
              autoComplete="off"
              disabled={busy || success !== undefined}
              onChange={(event) => setDeploymentNames(event.target.value)}
            />
          </label>
          <div className="gw-note">
            Leave the header field empty unless your gateway admin gave you a custom API-key header,
            for example X-Litellm-Key. Supported headers are Authorization, X-Litellm-Key,
            X-Api-Key, and api-key. Leave deployment names empty only for OpenAI-compatible gateways
            with model discovery. For Azure AI Foundry, paste deployment names exactly as shown in
            the Deployments tab. Testing several deployments can take up to 30 seconds.
          </div>
          {/* role=alert/status: the test result arrives after a long async wait
              while all controls are disabled — without a live region screen
              readers never hear it (audit C084). */}
          {error !== undefined ? (
            <div className="gw-error" role="alert">
              {error}
              {errorCode !== undefined ? (
                <div className="gw-error-code mono">{errorCode}</div>
              ) : null}
            </div>
          ) : null}
          {success !== undefined ? (
            <div className="gw-success" role="status">
              {success}
            </div>
          ) : null}
          <div className="gw-actions">
            {onCancel !== undefined ? (
              <button
                className="gw-cancel"
                type="button"
                disabled={busy || success !== undefined}
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
            <button
              className="gw-submit"
              type="submit"
              disabled={
                busy || success !== undefined || baseUrl.trim() === "" || apiKey.trim() === ""
              }
            >
              {busy ? "Testing connection…" : "Test & save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
}

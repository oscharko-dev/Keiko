"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError, setupGateway } from "@/lib/api";
import type { ModelCapability } from "@/lib/types";
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

function skippedModelSummary(skippedModelIds: readonly string[]): string {
  if (skippedModelIds.length === 0) return "";
  // "Could not verify", not "incompatible": a deployment can also be skipped for a transient reason
  // (rate-limit, timeout, content-filter), so the wording must not over-claim a permanent capability
  // verdict the smoke cannot prove.
  return ` Could not verify deployment${skippedModelIds.length === 1 ? "" : "s"}: ${skippedModelIds.join(", ")}.`;
}

export function GatewaySetupDialog({
  onCancel,
  preserveExisting = false,
  storedApiKeyHeaderName,
  storedModels = [],
}: {
  readonly onCancel?: (() => void) | undefined;
  readonly preserveExisting?: boolean | undefined;
  readonly storedApiKeyHeaderName?: string | undefined;
  readonly storedModels?: readonly ModelCapability[] | undefined;
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const figmaAccessTokenRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const reloadTimerRef = useRef<number | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState("");
  const [deploymentNames, setDeploymentNames] = useState("");
  const [imageInputModelIds, setImageInputModelIds] = useState("");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    const root = document.documentElement;
    const previousCount = Number(root.dataset.keikoModalOpenCount ?? "0");
    root.dataset.keikoModalOpenCount = String(previousCount + 1);
    root.setAttribute("data-keiko-modal-open", "true");
    triggerRef.current = document.activeElement as HTMLElement | null;
    if (preserveExisting) {
      figmaAccessTokenRef.current?.focus();
    } else {
      baseUrlRef.current?.focus();
    }
    return () => {
      if (reloadTimerRef.current !== undefined) {
        window.clearTimeout(reloadTimerRef.current);
      }
      const nextCount = Math.max(0, Number(root.dataset.keikoModalOpenCount ?? "1") - 1);
      if (nextCount === 0) {
        delete root.dataset.keikoModalOpenCount;
        root.removeAttribute("data-keiko-modal-open");
      } else {
        root.dataset.keikoModalOpenCount = String(nextCount);
      }
      triggerRef.current?.focus?.();
    };
  }, [preserveExisting]);

  const focusableInside = (root: HTMLElement): readonly HTMLElement[] => {
    const nodes = root.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex='-1'])",
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
      if (preserveExisting && baseUrl.trim() === "" && apiKey.trim() === "") {
        figmaAccessTokenRef.current?.focus();
      } else {
        baseUrlRef.current?.focus();
      }
    }
  }, [apiKey, baseUrl, busy, error, preserveExisting]);

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
      const parsedImageInputModelIds = deploymentNamesFromInput(imageInputModelIds);
      const submittedGatewayCredentials =
        !preserveExisting ||
        baseUrl.trim() !== "" ||
        apiKey.trim() !== "" ||
        apiKeyHeaderName.trim() !== "" ||
        parsedDeploymentNames.length > 0 ||
        parsedImageInputModelIds.length > 0;
      const submittedFigmaCredential = figmaAccessToken.trim() !== "";
      const result = await setupGateway({
        baseUrl: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        apiKey: apiKey.trim() === "" ? undefined : apiKey.trim(),
        apiKeyHeaderName: apiKeyHeaderName.trim() === "" ? undefined : apiKeyHeaderName.trim(),
        deploymentNames: parsedDeploymentNames,
        preserveExisting,
        ...(parsedImageInputModelIds.length === 0
          ? {}
          : { imageInputModelIds: parsedImageInputModelIds }),
        ...(figmaAccessToken.trim() === "" ? {} : { figmaAccessToken: figmaAccessToken.trim() }),
      });
      const count = result.testedModelIds.length;
      const skippedSummary = skippedModelSummary(result.skippedModelIds ?? []);
      setBusy(false);
      if (submittedFigmaCredential && !submittedGatewayCredentials) {
        setSuccess("Verified Figma access token. Reloading Keiko…");
      } else if (submittedFigmaCredential) {
        setSuccess(
          `Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"} and Figma access token. Reloading Keiko…${skippedSummary}`,
        );
      } else {
        setSuccess(
          `Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"}. Reloading Keiko…${skippedSummary}`,
        );
      }
      reloadTimerRef.current = window.setTimeout(
        () => window.location.reload(),
        (result.skippedModelIds ?? []).length === 0 ? 800 : 1800,
      );
    } catch (caught) {
      const details = errorDetails(caught);
      setError(details.message);
      setErrorCode(details.code);
      setBusy(false);
    }
  }

  // Issue #422: when this dialog is opened from the Settings panel, its
  // ancestors include `.ws-scene`, which applies CSS `zoom` and a translated
  // scene layer. Those can establish a containing block for `position: fixed`
  // descendants in Chromium, so the backdrop can end up sized to the zoomed
  // scene (which has zero intrinsic width/height) instead of the viewport.
  // Portalling to `document.body` makes the backdrop fixed to the viewport
  // regardless of where the dialog is mounted in the React tree.
  const parsedDeploymentNames = deploymentNamesFromInput(deploymentNames);
  const parsedImageInputModelIds = deploymentNamesFromInput(imageInputModelIds);
  const requiresGatewayCredentials = !preserveExisting;
  const hasGatewayCredentialInput =
    baseUrl.trim() !== "" ||
    apiKey.trim() !== "" ||
    apiKeyHeaderName.trim() !== "" ||
    parsedDeploymentNames.length > 0 ||
    parsedImageInputModelIds.length > 0;
  const hasFigmaCredentialInput = figmaAccessToken.trim() !== "";
  const canSubmit =
    !busy &&
    success === undefined &&
    (requiresGatewayCredentials
      ? baseUrl.trim() !== "" && apiKey.trim() !== ""
      : hasGatewayCredentialInput || hasFigmaCredentialInput);
  const dialogTitle = preserveExisting
    ? "Update Keiko credentials"
    : "Connect Keiko to your internal LLMs";
  const dialogDescription = preserveExisting
    ? "Leave stored gateway fields blank to keep the current value. Keiko never returns existing secrets to the browser."
    : "Keiko needs the internal gateway URL and API token before chat and agent workflows can run. The token is tested once and stored only on this machine.";
  const submitRequirements = preserveExisting
    ? "Enter at least one field to update. Blank stored gateway fields keep their current value."
    : "Base URL and API token are required. The Figma access token is optional.";
  const modelNames = storedModels.map((model) => model.id);
  const visibleModelNames = modelNames.slice(0, 6);
  const hiddenModelCount = Math.max(0, modelNames.length - visibleModelNames.length);
  const gatewayFields = (
    <div className="gw-grid">
      <label className="gw-field gw-span-2">
        <span>
          Base URL {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
        </span>
        <input
          className="gw-input mono"
          value={baseUrl}
          placeholder={
            preserveExisting
              ? "Only enter a value to replace the stored gateway URL"
              : "https://llm-gateway.example.com/v1"
          }
          autoComplete="off"
          disabled={busy || success !== undefined}
          ref={baseUrlRef}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label className="gw-field">
        <span>
          API token {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
        </span>
        <input
          className="gw-input mono"
          type="password"
          value={apiKey}
          placeholder={
            preserveExisting
              ? "Only enter a value to replace the stored token"
              : "Paste your API token"
          }
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
          placeholder={preserveExisting ? "Leave blank to keep stored header" : "Authorization"}
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
      <label className="gw-field">
        <span>
          Image-input models <span className="dlg-opt">optional</span>
        </span>
        <textarea
          className="gw-input gw-textarea mono"
          value={imageInputModelIds}
          placeholder="Paste image-capable model names, one per line"
          autoComplete="off"
          disabled={busy || success !== undefined}
          onChange={(event) => setImageInputModelIds(event.target.value)}
        />
      </label>
    </div>
  );

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
        <form className="gw-form" onSubmit={(event) => void submit(event)}>
          <div className="gw-head">
            <div className="gw-setup-badge">
              <Icons.cube size={18} />
              {preserveExisting ? "Credential update" : "Model gateway setup"}
            </div>
            <h1 id="gw-setup-title">{dialogTitle}</h1>
            <p id="gw-setup-desc">{dialogDescription}</p>
          </div>

          <section className="gw-section" aria-labelledby="gw-model-section-title">
            <div className="gw-section-head">
              <div>
                <h2 id="gw-model-section-title">Model gateway</h2>
                <p>
                  {preserveExisting
                    ? "Blank gateway fields keep the stored value."
                    : "Base URL and API token are required."}
                </p>
              </div>
            </div>
            {preserveExisting ? (
              <>
                <div className="gw-current" aria-label="Stored model gateway credentials">
                  <div className="gw-current-row">
                    <span>Gateway URL</span>
                    <strong>Stored</strong>
                  </div>
                  <div className="gw-current-row">
                    <span>API token</span>
                    <strong className="mono">••••••••••••</strong>
                  </div>
                  <div className="gw-current-row">
                    <span>API key header</span>
                    <strong className="mono">{storedApiKeyHeaderName ?? "authorization"}</strong>
                  </div>
                  <div className="gw-current-models">
                    <span>Configured models</span>
                    <div className="gw-model-chips">
                      {visibleModelNames.length === 0 ? (
                        <strong>Stored</strong>
                      ) : (
                        visibleModelNames.map((modelId) => (
                          <strong key={modelId} className="mono">
                            {modelId}
                          </strong>
                        ))
                      )}
                      {hiddenModelCount > 0 ? (
                        <strong>+{hiddenModelCount.toString()}</strong>
                      ) : null}
                    </div>
                  </div>
                </div>
                <details className="gw-replace">
                  <summary>Replace model gateway settings</summary>
                  {gatewayFields}
                </details>
              </>
            ) : (
              gatewayFields
            )}
          </section>

          <section className="gw-section" aria-labelledby="gw-figma-section-title">
            <div className="gw-section-head">
              <div>
                <h2 id="gw-figma-section-title">Figma Snapshot</h2>
                <p>Optional connector credential.</p>
              </div>
            </div>
            <label className="gw-field">
              <span>
                Figma access token <span className="dlg-opt">optional</span>
              </span>
              <input
                className="gw-input mono"
                type="password"
                value={figmaAccessToken}
                placeholder={
                  preserveExisting
                    ? "Stored Figma token is kept when blank"
                    : "Paste a read-only Figma PAT when needed"
                }
                autoComplete="off"
                disabled={busy || success !== undefined}
                ref={figmaAccessTokenRef}
                onChange={(event) => setFigmaAccessToken(event.target.value)}
              />
            </label>
          </section>

          <div className="gw-note">
            Stored secrets stay local and are never returned to the browser. Supported API-key
            headers: Authorization, X-Litellm-Key, X-Api-Key, api-key.
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
          {busy ? (
            <div className="gw-pending" role="status">
              Testing credentials…
            </div>
          ) : null}
          {/* FE-03: visually-hidden description tells AT users what is required
              when the submit button cannot be activated (WCAG 3.3.4). */}
          <span id="gw-submit-requirements" className="visually-hidden">
            {submitRequirements}
          </span>
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
              disabled={!canSubmit}
              aria-busy={busy}
              aria-describedby="gw-submit-requirements"
            >
              {busy ? "Testing credentials…" : "Test & save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
}

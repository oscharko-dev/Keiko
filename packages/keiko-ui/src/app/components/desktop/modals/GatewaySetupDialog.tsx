"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, setupGateway } from "@/lib/api";
import { Icons } from "../Icons";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "The gateway could not be configured.";
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
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState("");
  const [deploymentNames, setDeploymentNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    baseUrlRef.current?.focus();
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

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
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
        `Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"}. Reloading Keiko...`,
      );
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className="gw-setup-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="gw-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-setup-title"
        aria-describedby="gw-setup-desc"
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
            <span>API key header optional</span>
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
          {error !== undefined ? <div className="gw-error">{error}</div> : null}
          {success !== undefined ? <div className="gw-success">{success}</div> : null}
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
              {busy ? "Testing connection..." : "Test & save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

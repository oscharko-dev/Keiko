"use client";

import { useState, type FormEvent, type ReactNode } from "react";
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
    new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0)),
  );
}

function isAzureFoundryUrl(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

export function GatewaySetupDialog({ onCancel }: { readonly onCancel?: (() => void) | undefined }): ReactNode {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deploymentNames, setDeploymentNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const parsedDeploymentNames = deploymentNamesFromInput(deploymentNames);
      if (isAzureFoundryUrl(baseUrl) && parsedDeploymentNames.length === 0) {
        setError("Azure AI Foundry requires deployment names. Paste the names from the Deployments tab.");
        setBusy(false);
        return;
      }
      const result = await setupGateway({
        baseUrl,
        apiKey,
        deploymentNames: parsedDeploymentNames,
      });
      const count = result.testedModelIds.length;
      setSuccess(`Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"}. Reloading Keiko...`);
      window.setTimeout(() => window.location.reload(), 800);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className="gw-setup-backdrop" role="presentation">
      <form className="gw-setup" onSubmit={(event) => void submit(event)}>
        <div className="gw-setup-badge">
          <Icons.cube size={18} />
          Model gateway setup
        </div>
        <h1>Connect Keiko to your internal LLMs</h1>
        <p>
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
          Leave this empty only for OpenAI-compatible gateways with model discovery. For Azure AI Foundry,
          paste deployment names exactly as shown in the Deployments tab. Testing several deployments can take
          up to 30 seconds.
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
            disabled={busy || success !== undefined || baseUrl.trim() === "" || apiKey.trim() === ""}
          >
            {busy ? "Testing connection..." : "Test & save"}
          </button>
        </div>
      </form>
    </div>
  );
}

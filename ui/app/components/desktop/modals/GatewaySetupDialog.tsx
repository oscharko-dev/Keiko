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

export function GatewaySetupDialog({ onCancel }: { readonly onCancel?: (() => void) | undefined }): ReactNode {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
      const result = await setupGateway({ baseUrl, apiKey });
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
        <div className="gw-note">
          Keiko will try the URL as entered and, if needed, also the same URL with <span className="mono">/v1</span>.
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

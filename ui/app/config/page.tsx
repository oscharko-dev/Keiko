"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchConfig, fetchModels, ApiError } from "@/lib/api";
import type { ModelCapability, SafeGatewayConfig, SafeProviderConfig } from "@/lib/types";
import { costClassClasses, costClassLabel } from "@/lib/format";

// ---------------------------------------------------------------------------
// Provider config table (no apiKey — SafeProviderConfig never carries it)
// ---------------------------------------------------------------------------

function ProviderTable({ providers }: { providers: readonly SafeProviderConfig[] }): ReactNode {
  if (providers.length === 0) {
    return (
      <p className="mt-4 text-sm text-ink-muted">No providers configured.</p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Gateway provider configuration</caption>
        <thead>
          <tr className="border-b border-ink/10 text-left text-xs text-ink-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Name</th>
            <th scope="col" className="py-2 pr-4 font-medium">Model ID</th>
            <th scope="col" className="py-2 pr-4 font-medium">Base URL</th>
            <th scope="col" className="py-2 pr-4 font-medium">Timeout</th>
            <th scope="col" className="py-2 font-medium">Retries</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.name} className="border-b border-ink/10 hover:bg-surface-subtle">
              <td className="py-2 pr-4 font-medium text-ink">{p.name}</td>
              <td className="py-2 pr-4 font-mono text-xs text-ink">{p.modelId}</td>
              <td className="py-2 pr-4 font-mono text-xs text-ink-muted">{p.baseUrl}</td>
              <td className="py-2 pr-4 text-ink-muted">{p.timeoutMs.toString()} ms</td>
              <td className="py-2 text-ink-muted">{p.retries.toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model registry table
// ---------------------------------------------------------------------------

function BooleanCell({ value }: { value: boolean }): ReactNode {
  return (
    <td className="py-2 pr-3">
      <span
        className={value ? "text-green-700" : "text-ink-muted"}
        aria-label={value ? "yes" : "no"}
      >
        {value ? "✓" : "–"}
      </span>
    </td>
  );
}

function ModelTable({ models }: { models: ModelCapability[] }): ReactNode {
  if (models.length === 0) {
    return <p className="mt-4 text-sm text-ink-muted">No models in registry.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Model capability registry</caption>
        <thead>
          <tr className="border-b border-ink/10 text-left text-xs text-ink-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Model ID</th>
            <th scope="col" className="py-2 pr-3 font-medium">Kind</th>
            <th scope="col" className="py-2 pr-3 font-medium">Context</th>
            <th scope="col" className="py-2 pr-3 font-medium">Max output</th>
            <th scope="col" className="py-2 pr-3 font-medium">Cost</th>
            <th scope="col" className="py-2 pr-3 font-medium">Latency</th>
            <th scope="col" className="py-2 pr-3 font-medium">Tools</th>
            <th scope="col" className="py-2 pr-3 font-medium">Structured</th>
            <th scope="col" className="py-2 font-medium">Streaming</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id} className="border-b border-ink/10 hover:bg-surface-subtle">
              <td className="py-2 pr-3 font-mono text-xs font-medium text-ink">{m.id}</td>
              <td className="py-2 pr-3 text-ink-muted">{m.kind}</td>
              <td className="py-2 pr-3 font-mono text-xs text-ink-muted">
                {(m.contextWindow / 1000).toFixed(0)}k
              </td>
              <td className="py-2 pr-3 font-mono text-xs text-ink-muted">
                {(m.maxOutputTokens / 1000).toFixed(0)}k
              </td>
              <td className="py-2 pr-3">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${costClassClasses(m.costClass)}`}
                >
                  {costClassLabel(m.costClass)}
                </span>
              </td>
              <td className="py-2 pr-3 text-ink-muted">{m.latencyClass}</td>
              <BooleanCell value={m.toolCalling} />
              <BooleanCell value={m.structuredOutput} />
              <BooleanCell value={m.streaming} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model detail (preferredUseCases, knownLimitations) — expandable rows
// ---------------------------------------------------------------------------

function ModelDetailList({ models }: { models: ModelCapability[] }): ReactNode {
  const withDetails = models.filter(
    (m) => m.preferredUseCases.length > 0 || m.knownLimitations.length > 0,
  );
  if (withDetails.length === 0) return null;

  return (
    <div className="mt-6 grid gap-4">
      {withDetails.map((m) => (
        <div key={m.id} className="rounded-lg border border-ink/10 p-4">
          <h3 className="font-mono text-sm font-semibold text-ink">{m.id}</h3>
          {m.preferredUseCases.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-ink-muted">Preferred use cases</p>
              <ul className="mt-1 grid gap-0.5">
                {m.preferredUseCases.map((uc) => (
                  <li key={uc} className="text-xs text-ink">
                    {uc}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {m.knownLimitations.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-ink-muted">Known limitations</p>
              <ul className="mt-1 grid gap-0.5">
                {m.knownLimitations.map((lim) => (
                  <li key={lim} className="text-xs text-orange-700">
                    {lim}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigPage
// ---------------------------------------------------------------------------

export default function ConfigPage(): ReactNode {
  const [config, setConfig] = useState<SafeGatewayConfig | null>(null);
  const [configPresent, setConfigPresent] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([fetchConfig(), fetchModels()])
      .then(([cfg, mdl]) => {
        if (!active) return;
        setConfig(cfg.config);
        setConfigPresent(cfg.configPresent);
        setModels(mdl.models);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load configuration";
        setLoadError(msg);
        setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <section aria-labelledby="config-heading">
      <h1 id="config-heading" className="text-heading text-ink">
        Config &amp; model inspector
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Active gateway configuration and the full model capability registry. No credentials are
        shown — API keys are stripped server-side before this page receives any data.
      </p>

      {loadError !== null && (
        <p role="alert" className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </p>
      )}

      {loading && (
        <p className="mt-4 text-ink-muted" aria-busy="true">
          Loading configuration…
        </p>
      )}

      {!loading && loadError === null && (
        <>
          {/* Gateway configuration */}
          <section aria-labelledby="gateway-config-heading" className="mt-section">
            <h2 id="gateway-config-heading" className="text-subheading text-ink">
              Gateway configuration
            </h2>

            {configPresent === false || config === null ? (
              <div className="mt-4 rounded-lg border border-ink/10 bg-surface-subtle p-6 text-center">
                <p className="text-sm font-medium text-ink">No configuration file found</p>
                <p className="mt-1 text-sm text-ink-muted">
                  Start Keiko with a valid gateway config file to see provider details here.
                </p>
              </div>
            ) : (
              <ProviderTable providers={config.providers} />
            )}
          </section>

          {/* Model capability registry */}
          <section aria-labelledby="model-registry-heading" className="mt-section">
            <h2 id="model-registry-heading" className="text-subheading text-ink">
              Model registry
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              {models.length.toString()} model{models.length !== 1 ? "s" : ""} in registry
            </p>
            <ModelTable models={models} />
            <ModelDetailList models={models} />
          </section>
        </>
      )}
    </section>
  );
}

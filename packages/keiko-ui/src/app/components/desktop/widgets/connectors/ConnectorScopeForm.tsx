// Issue #2245 (Epic #2238, ADR-0128 D5) — sync scope selection.
//
// Confluence: space keys; Jira: project keys plus an optional JQL filter. Key entry mirrors the
// contract validators (`isSafeConfluenceSpaceKey` / `isSafeJiraProjectKey`) and enforces the scope
// bound (`ATLASSIAN_SYNC_SCOPE_MAX_KEYS`) with inline feedback; the per-run item bound
// (`DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxItems`) is surfaced so truncation is understood. The JQL hint
// states plainly that JQL runs under the user's own Atlassian permissions.

"use client";

import { useId, useState, type ReactNode } from "react";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  isSafeConfluenceSpaceKey,
  isSafeJiraProjectKey,
  type AtlassianConnectorProvider,
} from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

export interface ConnectorScopeValue {
  readonly keys: readonly string[];
  readonly jql: string;
}

function isValidKey(provider: AtlassianConnectorProvider, key: string): boolean {
  return provider === "confluence" ? isSafeConfluenceSpaceKey(key) : isSafeJiraProjectKey(key);
}

interface ScopeState {
  readonly keys: readonly string[];
  readonly draft: string;
  readonly jql: string;
  readonly error: MessageKey | undefined;
  readonly setDraft: (value: string) => void;
  readonly setJql: (value: string) => void;
  readonly addKey: () => void;
  readonly removeKey: (key: string) => void;
}

function useScopeState(
  provider: AtlassianConnectorProvider,
  onChange: (value: ConnectorScopeValue) => void,
): ScopeState {
  const [keys, setKeys] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [jql, setJql] = useState("");
  const [error, setError] = useState<MessageKey | undefined>();
  const emit = (nextKeys: readonly string[], nextJql: string): void => {
    onChange({ keys: nextKeys, jql: nextJql });
  };
  const addKey = (): void => {
    const key = draft.trim();
    if (key.length === 0) return;
    if (!isValidKey(provider, key)) return setError("atlassianConnectors.scope.invalidKey");
    if (keys.includes(key)) return setError("atlassianConnectors.scope.duplicateKey");
    if (keys.length >= ATLASSIAN_SYNC_SCOPE_MAX_KEYS) {
      return setError("atlassianConnectors.scope.maxKeys");
    }
    const nextKeys = [...keys, key];
    setKeys(nextKeys);
    setDraft("");
    setError(undefined);
    emit(nextKeys, jql);
  };
  const removeKey = (key: string): void => {
    const nextKeys = keys.filter((entry) => entry !== key);
    setKeys(nextKeys);
    emit(nextKeys, jql);
  };
  const updateJql = (value: string): void => {
    setJql(value);
    emit(keys, value);
  };
  return { keys, draft, jql, error, setDraft, setJql: updateJql, addKey, removeKey };
}

function ScopeChips({
  keys,
  onRemove,
}: {
  readonly keys: readonly string[];
  readonly onRemove: (key: string) => void;
}): ReactNode {
  const t = useTranslate();
  if (keys.length === 0) return null;
  return (
    <ul className="acx-chips" data-testid="acx-scope-keys">
      {keys.map((key) => (
        <li key={key} className="acx-chip" data-key={key}>
          {key}
          <button
            type="button"
            className="acx-chip-remove"
            aria-label={t("atlassianConnectors.scope.removeKey", { key })}
            onClick={() => onRemove(key)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function JqlField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-field">
      <label className="acx-label" htmlFor={id}>
        {t("atlassianConnectors.scope.jqlLabel")}
      </label>
      <input
        id={id}
        className="acx-input"
        type="text"
        value={value}
        maxLength={ATLASSIAN_JQL_MAX_CHARS}
        placeholder={t("atlassianConnectors.scope.jqlPlaceholder")}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="acx-hint" id={`${id}-hint`}>
        {t("atlassianConnectors.scope.jqlHint")}
      </p>
    </div>
  );
}

export function ConnectorScopeForm({
  provider,
  onChange,
}: {
  readonly provider: AtlassianConnectorProvider;
  readonly onChange: (value: ConnectorScopeValue) => void;
}): ReactNode {
  const t = useTranslate();
  const prefix = useId();
  const scope = useScopeState(provider, onChange);
  const labelKey: MessageKey =
    provider === "confluence"
      ? "atlassianConnectors.scope.confluenceLabel"
      : "atlassianConnectors.scope.jiraLabel";
  const placeholderKey: MessageKey =
    provider === "confluence"
      ? "atlassianConnectors.scope.confluencePlaceholder"
      : "atlassianConnectors.scope.jiraPlaceholder";
  return (
    <div className="acx-section" data-testid="acx-scope">
      <div className="acx-field">
        <label className="acx-label" htmlFor={`${prefix}-key`}>
          {t(labelKey)}
        </label>
        <div className="acx-actions">
          <input
            id={`${prefix}-key`}
            className="acx-input"
            type="text"
            value={scope.draft}
            placeholder={t(placeholderKey)}
            aria-describedby={`${prefix}-key-hint`}
            aria-invalid={scope.error !== undefined}
            onChange={(event) => scope.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                scope.addKey();
              }
            }}
          />
          <button type="button" className="lk-btn" onClick={scope.addKey}>
            {t("atlassianConnectors.scope.addKey")}
          </button>
        </div>
        {scope.error !== undefined ? (
          <p className="acx-error" role="alert">
            {t(scope.error)}
          </p>
        ) : null}
        <p className="acx-hint" id={`${prefix}-key-hint`}>
          {t("atlassianConnectors.scope.keyHint", { max: ATLASSIAN_SYNC_SCOPE_MAX_KEYS })}
        </p>
      </div>
      <ScopeChips keys={scope.keys} onRemove={scope.removeKey} />
      {provider === "jira" ? (
        <JqlField id={`${prefix}-jql`} value={scope.jql} onChange={scope.setJql} />
      ) : null}
      <p className="acx-hint">
        {t("atlassianConnectors.scope.bounds", {
          maxItems: DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxItems,
        })}
      </p>
    </div>
  );
}

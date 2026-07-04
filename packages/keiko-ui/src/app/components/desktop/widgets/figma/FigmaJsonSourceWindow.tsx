"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import {
  loadFigmaSnapshotScreenJson,
  type FigmaSnapshotScreenJsonResponse,
} from "@/lib/figma-snapshot-api";
import { JsonSyntaxBlock, jsonTextByteLength } from "./JsonSyntaxBlock";

export interface FigmaJsonSourceWindowProps {
  readonly snapshotRunId?: string | undefined;
  readonly screenId?: string | undefined;
  readonly screenName?: string | undefined;
  readonly loadScreenJsonImpl?: typeof loadFigmaSnapshotScreenJson;
}

type JsonLoadState = "idle" | "loading" | "done" | "error";

function labelFrom(screenName: string | undefined, screenId: string | undefined): string {
  const name = screenName?.trim();
  if (name !== undefined && name.length > 0) return name;
  return screenId?.trim() ?? "Selected Figma view";
}

export function FigmaJsonSourceWindow({
  snapshotRunId,
  screenId,
  screenName,
  loadScreenJsonImpl = loadFigmaSnapshotScreenJson,
}: FigmaJsonSourceWindowProps): ReactNode {
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<JsonLoadState>("idle");
  const [screenJson, setScreenJson] = useState<FigmaSnapshotScreenJsonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const label = labelFrom(screenName, screenId);
  const jsonText = useMemo(
    () => (screenJson === null ? "" : JSON.stringify(screenJson, null, 2)),
    [screenJson],
  );
  const jsonBytes = useMemo(() => jsonTextByteLength(jsonText), [jsonText]);

  const loadJson = useCallback((): void => {
    if (
      snapshotRunId === undefined ||
      snapshotRunId.trim().length === 0 ||
      screenId === undefined ||
      screenId.trim().length === 0
    ) {
      setScreenJson(null);
      setState("error");
      setError("Missing Figma JSON source reference.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState("loading");
    setError(null);
    setCopyStatus(null);
    loadScreenJsonImpl(snapshotRunId, screenId, controller.signal)
      .then((result) => {
        setScreenJson(result);
        setState("done");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setScreenJson(null);
        setError(err instanceof Error ? err.message : "Failed to load Figma JSON.");
        setState("error");
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
  }, [loadScreenJsonImpl, screenId, snapshotRunId]);

  useEffect(() => {
    loadJson();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [loadJson]);

  const copyJson = useCallback((): void => {
    if (jsonText.length === 0) return;
    if (navigator.clipboard === undefined) {
      setCopyStatus("Clipboard unavailable");
      return;
    }
    navigator.clipboard
      .writeText(jsonText)
      .then(() => setCopyStatus("Copied"))
      .catch(() => setCopyStatus("Copy failed"));
  }, [jsonText]);

  return (
    <section className="figma-json-window" aria-label={`Figma JSON source ${label}`}>
      <header className="figma-json-header">
        <div>
          <p className="figma-json-eyebrow">Figma JSON</p>
          <h1 className="figma-json-heading" title={label}>
            {label}
          </h1>
          <p className="figma-json-meta">
            {screenJson !== null
              ? `${screenJson.screen.kind} · ${formatBytes(jsonBytes)} · captured ${formatDate(
                  screenJson.fetchedAt,
                )}`
              : screenId}
          </p>
        </div>
        <div className="figma-json-actions">
          <span className="figma-view-source-badge">QI source</span>
          <button
            type="button"
            className="figma-view-json-copy-btn"
            onClick={copyJson}
            disabled={jsonText.length === 0}
            aria-disabled={jsonText.length === 0 ? "true" : undefined}
          >
            Copy JSON
          </button>
        </div>
      </header>

      {state === "loading" ? (
        <p className="figma-json-status" role="status">
          Loading JSON…
        </p>
      ) : null}
      {state === "error" && error !== null ? (
        <div className="figma-json-error" role="alert">
          <p>{error}</p>
          <button type="button" className="figma-snapshot-load-btn" onClick={loadJson}>
            Retry
          </button>
        </div>
      ) : null}
      {copyStatus !== null ? (
        <p className="figma-view-json-copy-status" role="status">
          {copyStatus}
        </p>
      ) : null}
      {state === "done" && jsonText.length > 0 ? (
        <JsonSyntaxBlock
          text={jsonText}
          className="figma-json-code"
          ariaLabel="Figma export JSON"
        />
      ) : null}
    </section>
  );
}

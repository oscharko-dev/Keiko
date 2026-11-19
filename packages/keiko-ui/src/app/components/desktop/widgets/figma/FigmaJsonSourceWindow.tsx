"use client";

import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { correlationIdOf } from "@/lib/client-error-summary";
import {
  loadFigmaSnapshotScreenJson,
  type FigmaSnapshotScreenJsonResponse,
} from "@/lib/figma-snapshot-api";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
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

function matchesSource(
  json: FigmaSnapshotScreenJsonResponse | null,
  runId: string | undefined,
  screenId: string | undefined,
): json is FigmaSnapshotScreenJsonResponse {
  return json !== null && json.runId === runId && json.screen.screenId === screenId;
}

export function FigmaJsonSourceWindow({
  snapshotRunId,
  screenId,
  screenName,
  loadScreenJsonImpl = loadFigmaSnapshotScreenJson,
}: FigmaJsonSourceWindowProps): ReactNode {
  const tUi = useOptionalWidgetTranslate();
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<JsonLoadState>("idle");
  const [loadedJson, setLoadedJson] = useState<FigmaSnapshotScreenJsonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const label = labelFrom(screenName, screenId);
  const screenJson = matchesSource(loadedJson, snapshotRunId, screenId) ? loadedJson : null;
  const jsonText = useMemo(
    () => (screenJson === null ? "" : JSON.stringify(screenJson, null, 2)),
    [screenJson],
  );
  const jsonBytes = useMemo(() => jsonTextByteLength(jsonText), [jsonText]);

  const loadJson = useCallback((): void => {
    abortRef.current?.abort();
    setLoadedJson(null);
    setCopyStatus(null);
    if (
      snapshotRunId === undefined ||
      snapshotRunId.trim().length === 0 ||
      screenId === undefined ||
      screenId.trim().length === 0
    ) {
      setState("error");
      setError(tUi("figmaJson.ui.missingReference"));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState("loading");
    setError(null);
    loadScreenJsonImpl(snapshotRunId, screenId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!matchesSource(result, snapshotRunId, screenId)) {
          reportClientDiagnostic("[keiko] Figma snapshot JSON source reference mismatch.");
          setError(tUi("figmaJson.ui.loadFailed"));
          setState("error");
          return;
        }
        setLoadedJson(result);
        setState("done");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        reportClientDiagnostic("[keiko] Figma snapshot JSON source load failed.", {
          correlationId: correlationIdOf(err),
        });
        setError(err instanceof Error ? err.message : tUi("figmaJson.ui.loadFailed"));
        setState("error");
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
  }, [loadScreenJsonImpl, screenId, snapshotRunId, tUi]);

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
      setCopyStatus(tUi("figmaSnapshotWindow.jsonInspector.clipboardUnavailable"));
      return;
    }
    navigator.clipboard
      .writeText(jsonText)
      .then(() => setCopyStatus(tUi("figmaSnapshotWindow.jsonInspector.copied")))
      .catch(() => setCopyStatus(tUi("figmaSnapshotWindow.jsonInspector.copyFailed")));
  }, [jsonText, tUi]);

  return (
    <section className="figma-json-window" aria-label={`Figma JSON source ${label}`}>
      <header className="figma-json-header">
        <div>
          <p className="figma-json-eyebrow">{tUi("figmaJson.ui.figmaJson")}</p>
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
          <span className="figma-view-source-badge">{tUi("figmaJson.ui.qiSource")}</span>
          <button
            type="button"
            className="figma-view-json-copy-btn"
            onClick={copyJson}
            disabled={jsonText.length === 0}
            aria-disabled={jsonText.length === 0 ? "true" : undefined}
          >
            {tUi("figmaJson.ui.copyJson")}
          </button>
        </div>
      </header>

      {state === "loading" ? (
        <output className="figma-json-status" style={NATIVE_BLOCK_STYLE}>
          {tUi("figmaJson.ui.loadingJson")}
        </output>
      ) : null}
      {state === "error" && error !== null ? (
        <div className="figma-json-error" role="alert">
          <p>{error}</p>
          <button type="button" className="figma-snapshot-load-btn" onClick={loadJson}>
            {tUi("figmaJson.ui.retry")}
          </button>
        </div>
      ) : null}
      {copyStatus !== null ? (
        <output className="figma-view-json-copy-status" style={NATIVE_BLOCK_STYLE}>
          {copyStatus}
        </output>
      ) : null}
      {jsonText.length > 0 ? (
        <JsonSyntaxBlock
          text={jsonText}
          className="figma-json-code"
          ariaLabel="Figma export JSON"
        />
      ) : null}
    </section>
  );
}

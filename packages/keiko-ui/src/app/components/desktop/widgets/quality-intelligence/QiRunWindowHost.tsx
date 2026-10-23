"use client";

import type { ReactNode } from "react";
import type { QualityIntelligenceUiRegenerateResult } from "@oscharko-dev/keiko-contracts";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import { QiRunCard } from "./QiRunCard";
import { useQiTranslate } from "./qi-i18n";
import {
  connectedRunSourcesCfgFromSources,
  connectedRunSourcesFromWindowCfg,
} from "./connectedSources";

export function QiRunWindowHost({
  cfg,
  ctx,
}: {
  readonly cfg: WindowCfgRecord;
  readonly ctx: WindowRenderContext;
}): ReactNode {
  const t = useQiTranslate();
  const runId = cfg.runId;
  if (typeof runId !== "string" || runId === "") {
    return (
      <div className="lk-empty">
        <p className="lk-empty-body">{t("qi.run.openFromHub")}</p>
      </div>
    );
  }
  const connectedSources = connectedRunSourcesFromWindowCfg(cfg);
  const sourceCfg = connectedRunSourcesCfgFromSources(connectedSources);
  return (
    <QiRunCard
      runId={runId}
      connectedSources={connectedSources}
      // Regeneration opens a new immutable run with the original source set for further re-checks.
      onRegenerated={(result: QualityIntelligenceUiRegenerateResult) => {
        ctx.openWindow("qiRun", { runId: result.runId, ...sourceCfg });
      }}
    />
  );
}

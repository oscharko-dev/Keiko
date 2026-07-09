"use client";

import { Suspense, type ReactNode } from "react";

import { useLocalKnowledgeTranslate as useTranslate } from "../local-knowledge-i18n";
import { CapsuleDetail } from "../[capsuleId]/capsule-detail";
import detailStyles from "../capsule-detail.module.css";

export function CapsuleDetailPageBody(): ReactNode {
  const t = useTranslate();

  return (
    <main
      className={`lk-page ${detailStyles.detailPage}`}
      aria-label={t("localKnowledge.detail.pageLabel")}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            {t("localKnowledge.detail.loading")}
          </p>
        }
      >
        <CapsuleDetail />
      </Suspense>
    </main>
  );
}

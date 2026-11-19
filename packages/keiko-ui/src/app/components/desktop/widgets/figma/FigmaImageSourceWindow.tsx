"use client";

import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { isSafeFigmaImageSrc } from "../../figma-image-drag";
import styles from "./FigmaImageSourceWindow.module.css";

export interface FigmaImageSourceWindowProps {
  readonly snapshotRunId?: string | undefined;
  readonly imageSrc?: string | undefined;
  readonly screenName?: string | undefined;
}

function labelFrom(screenName: string | undefined): string {
  const name = screenName?.trim();
  return name !== undefined && name.length > 0 ? name : "Figma image source";
}

export function FigmaImageSourceWindow({
  snapshotRunId,
  imageSrc,
  screenName,
}: FigmaImageSourceWindowProps): ReactNode {
  const tUi = useOptionalWidgetTranslate();
  const label = labelFrom(screenName);
  const [failedImageSrc, setFailedImageSrc] = useState<string>();
  if (
    imageSrc === undefined ||
    snapshotRunId === undefined ||
    !isSafeFigmaImageSrc(imageSrc, snapshotRunId) ||
    failedImageSrc === imageSrc
  ) {
    return (
      <section className={`figma-image-window ${styles.lazyWidgetScope}`} aria-label={label}>
        <div className="figma-image-missing" role="alert">
          {tUi("figmaImage.ui.imagePreviewIsUnavailable")}
        </div>
      </section>
    );
  }

  return (
    <section className={`figma-image-window ${styles.lazyWidgetScope}`} aria-label={label}>
      <Image
        className="figma-image-preview"
        src={imageSrc}
        alt={label}
        width={720}
        height={480}
        loading="eager"
        onError={() => {
          reportClientDiagnostic("[keiko] Figma snapshot image preview failed.");
          setFailedImageSrc(imageSrc);
        }}
      />
    </section>
  );
}

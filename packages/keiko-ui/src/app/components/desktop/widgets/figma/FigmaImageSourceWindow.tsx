"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import "./FigmaImageSourceWindow.module.css";

export interface FigmaImageSourceWindowProps {
  readonly imageSrc?: string | undefined;
  readonly screenName?: string | undefined;
}

function labelFrom(screenName: string | undefined): string {
  const name = screenName?.trim();
  return name !== undefined && name.length > 0 ? name : "Figma image source";
}

export function FigmaImageSourceWindow({
  imageSrc,
  screenName,
}: FigmaImageSourceWindowProps): ReactNode {
  const label = labelFrom(screenName);
  if (imageSrc === undefined || imageSrc.trim().length === 0) {
    return (
      <section className="figma-image-window" aria-label={label}>
        <div className="figma-image-missing" role="alert">
          Image preview is unavailable.
        </div>
      </section>
    );
  }

  return (
    <section className="figma-image-window" aria-label={label}>
      <Image
        className="figma-image-preview"
        src={imageSrc}
        alt={label}
        width={720}
        height={480}
        priority
      />
    </section>
  );
}

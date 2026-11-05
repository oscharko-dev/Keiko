import Image from "next/image";
import type { ReactNode } from "react";

/** Shared Pod identity: the same glyph at list, drag-preview and workspace sizes. */
export function PodIcon({
  kind,
  size = 15,
}: {
  readonly kind: "capsule" | "capsule-set" | "jira-live";
  readonly size?: number;
}): ReactNode {
  return kind === "jira-live" ? (
    <Image
      src="/assets/brands/jira.svg?v=ad20a139"
      alt={/* i18n-exempt: Jira is a product trademark. */ "Jira"}
      width={size}
      height={size}
      unoptimized
    />
  ) : (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5.2 1.8h9.6l4.6 8.2-4.6 8.2H5.2L.6 10z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

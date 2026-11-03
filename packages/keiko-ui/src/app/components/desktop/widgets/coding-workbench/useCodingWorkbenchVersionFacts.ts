"use client";
import { useEffect, useState } from "react";
import type {
  CodingWorkbenchRuntimeOrigin,
  CodingWorkbenchRuntimeVersion,
  UpdatePreflightReport,
} from "@oscharko-dev/keiko-contracts";
import { fetchStartupUpdatePreflight } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";

/** What the startup update check found: the newest Keiko release, or that it could not tell. */
export type LatestKeikoRelease =
  | { readonly kind: "checking" }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "unknown" };

interface VersionFact {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "warning";
}

const ORIGIN_KEYS: Readonly<Record<CodingWorkbenchRuntimeOrigin, CodingWorkbenchMessageKey>> = {
  "portable-release": "codingWorkbench.info.runtimeOrigin.portable-release",
  "npm-runtime-package": "codingWorkbench.info.runtimeOrigin.npm-runtime-package",
  "dev-checkout": "codingWorkbench.info.runtimeOrigin.dev-checkout",
};

// Only a check that reached the release source can name a newest release; anything else is unknown.
export function latestKeikoReleaseOf(report: UpdatePreflightReport): LatestKeikoRelease {
  if (report.updateAvailable && report.targetVersion !== undefined)
    return { kind: "available", version: report.targetVersion };
  return report.status === "current"
    ? { kind: "current", version: report.currentVersion }
    : { kind: "unknown" };
}

/**
 * The newest Keiko release, from the server's startup update check (#3904 AC4). It is read when the
 * information opens; the Workbench starts no update check of its own and needs no internet for it.
 */
function useLatestKeikoRelease(): LatestKeikoRelease {
  const [latest, setLatest] = useState<LatestKeikoRelease>({ kind: "checking" });
  useEffect(() => {
    let mounted = true;
    fetchStartupUpdatePreflight().then(
      (report) => {
        if (mounted) setLatest(latestKeikoReleaseOf(report));
      },
      (error: unknown) => {
        reportClientDiagnostic(
          `[keiko] coding workbench release facts failed: ${clientErrorSummary(error)}`,
          { correlationId: correlationIdOf(error) },
        );
        if (mounted) setLatest({ kind: "unknown" });
      },
    );
    return (): void => {
      mounted = false;
    };
  }, []);
  return latest;
}

/** The runtime that runs, as its verified release metadata names it, and what this build pins. */
function runtimeVersionFact(
  version: CodingWorkbenchRuntimeVersion | undefined,
  t: CodingWorkbenchTranslate,
): VersionFact {
  const label = t("codingWorkbench.info.runtimeVersion");
  if (version === undefined) return { label, value: t("codingWorkbench.info.notReported") };
  const values = { version: version.opencode, origin: t(ORIGIN_KEYS[version.origin]) };
  if (version.opencode === version.pinned)
    return { label, value: t("codingWorkbench.info.runtimeVersion.value", values) };
  return {
    label,
    tone: "warning",
    value: t("codingWorkbench.info.runtimeVersion.pinned", { ...values, pinned: version.pinned }),
  };
}

function latestKeikoReleaseFact(
  latest: LatestKeikoRelease,
  t: CodingWorkbenchTranslate,
): VersionFact {
  const label = t("codingWorkbench.info.latestRelease");
  if (latest.kind === "checking")
    return { label, value: t("codingWorkbench.info.latestRelease.checking") };
  if (latest.kind === "unknown")
    return { label, value: t("codingWorkbench.info.latestRelease.unknown") };
  if (latest.kind === "current")
    return {
      label,
      value: t("codingWorkbench.info.latestRelease.current", { version: latest.version }),
    };
  return {
    label,
    tone: "warning",
    value: t("codingWorkbench.info.latestRelease.available", { version: latest.version }),
  };
}

/** The installed runtime and the newest Keiko release, which delivers a newer runtime (#3904 AC4). */
export function useCodingWorkbenchVersionFacts(
  version: CodingWorkbenchRuntimeVersion | undefined,
): readonly VersionFact[] {
  const t = useCodingWorkbenchTranslate();
  const latest = useLatestKeikoRelease();
  return [runtimeVersionFact(version, t), latestKeikoReleaseFact(latest, t)];
}

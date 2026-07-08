"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
} from "@/lib/api";
import type {
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchMode,
  CodingWorkbenchSidecarGatewayResult,
} from "@oscharko-dev/keiko-contracts";
import {
  ActionControls,
  AuthoritySummary,
  ModeAuthority,
  PermissionPrompt,
  PolicyDenials,
  RunSummary,
  Timeline,
  WorkbenchHeader,
} from "./CodingWorkbenchSections";
import { ModelRuntimeStatus } from "./CodingWorkbenchModelCards";
import {
  codingWorkbenchProjectionForState,
  type CodingWorkbenchProjection,
} from "./codingWorkbenchProjection";
import { isActiveRunState } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

export interface CodingWorkbenchWindowApi {
  readonly fetchSidecarGatewayProfile: () => Promise<CodingWorkbenchSidecarGatewayResult>;
  readonly fetchCodexSubscriptionProfile: () => Promise<CodingWorkbenchCodexSubscriptionProfile>;
}

export type CodingWorkbenchProfileState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly sidecarGateway: CodingWorkbenchSidecarGatewayResult;
      readonly codexProfile: CodingWorkbenchCodexSubscriptionProfile;
    }
  | { readonly status: "unavailable" };

export type CodingWorkbenchRequestState =
  "idle" | "stop-requested" | "takeover-requested" | "approved" | "denied";

interface CodingWorkbenchWindowProps {
  readonly projection?: CodingWorkbenchProjection;
  readonly state?: string | undefined;
  readonly api?: CodingWorkbenchWindowApi;
  readonly onStopRun?: ((runId: string) => void) | undefined;
  readonly onTakeOver?: ((runId: string) => void) | undefined;
}

const DEFAULT_API: CodingWorkbenchWindowApi = {
  fetchSidecarGatewayProfile: fetchCodingWorkbenchSidecarGatewayProfile,
  fetchCodexSubscriptionProfile: fetchCodingWorkbenchCodexSubscriptionProfile,
};

export function CodingWorkbenchWindow({
  projection: providedProjection,
  state,
  api = DEFAULT_API,
  onStopRun,
  onTakeOver,
}: CodingWorkbenchWindowProps): ReactNode {
  const projection = providedProjection ?? codingWorkbenchProjectionForState(state);
  const [selectedMode, setSelectedMode] = useState<CodingWorkbenchMode>(
    projection.authority.requestedMode,
  );
  const [profiles, setProfiles] = useState<CodingWorkbenchProfileState>({ status: "loading" });
  const [requestState, setRequestState] = useState<CodingWorkbenchRequestState>("idle");

  useEffect(() => setSelectedMode(projection.authority.requestedMode), [projection]);
  useEffect(() => setRequestState("idle"), [projection.authority.runId, projection.runState]);
  useProfiles(api, setProfiles);

  const stopRun = (): void => {
    setRequestState("stop-requested");
    onStopRun?.(projection.authority.runId);
  };
  const takeOver = (): void => {
    setRequestState("takeover-requested");
    onTakeOver?.(projection.authority.runId);
  };

  return (
    <section
      className={styles.shell}
      aria-label="Coding Workbench"
      aria-busy={isActiveRunState(projection.runState)}
      data-state={projection.runState}
    >
      <WorkbenchHeader projection={projection} />
      <div className={styles.grid}>
        <div className={styles.stack}>
          <ModeAuthority
            options={projection.modeOptions}
            selectedMode={selectedMode}
            locked={isActiveRunState(projection.runState)}
            onModeChange={setSelectedMode}
          />
          <ModelRuntimeStatus projection={projection} profiles={profiles} />
          <AuthoritySummary projection={projection} />
        </div>
        <div className={styles.stack}>
          <RunSummary projection={projection} />
          <ActionControls
            projection={projection}
            requestState={requestState}
            onStop={stopRun}
            onTakeOver={takeOver}
          />
          <PermissionPrompt projection={projection} onRequestState={setRequestState} />
          <PolicyDenials denials={projection.policyDenials} />
          <Timeline events={projection.timeline} />
        </div>
      </div>
    </section>
  );
}

function useProfiles(
  api: CodingWorkbenchWindowApi,
  setProfiles: (state: CodingWorkbenchProfileState) => void,
): void {
  useEffect(() => {
    let alive = true;
    Promise.all([api.fetchSidecarGatewayProfile(), api.fetchCodexSubscriptionProfile()])
      .then(([sidecarGateway, codexProfile]) => {
        if (alive) setProfiles({ status: "ready", sidecarGateway, codexProfile });
      })
      .catch(() => {
        if (alive) setProfiles({ status: "unavailable" });
      });
    return () => {
      alive = false;
    };
  }, [api, setProfiles]);
}

export default CodingWorkbenchWindow;

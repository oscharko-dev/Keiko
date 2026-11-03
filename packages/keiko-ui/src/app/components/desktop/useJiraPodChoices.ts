"use client";
import { useEffect, useState } from "react";
import type {
  AtlassianConnectorMetadata,
  listAtlassianConnectors,
} from "@/lib/atlassian-connectors-api";
import { useConnectorRefresh } from "./useConnectorRefresh";

/**
 * The Jira Pods the caller owns, read from the canonical connector listing. Ordinary Chat and the
 * Coding Workbench composer share this one read; neither event nor focus carries authority.
 */
export interface PodChoice {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
}
function podChoices(metadata: readonly AtlassianConnectorMetadata[]): readonly PodChoice[] {
  return metadata.flatMap((item) =>
    item.deployment !== "data-center" || item.livePod === undefined
      ? []
      : [
          {
            id: item.livePod.podId,
            name: item.displayName,
            ready:
              item.livePod.verificationStatus === "ok" &&
              !item.livePod.verificationInProgress &&
              item.livePod.capabilities.includes("live-read"),
          },
        ],
  );
}
export function usePodChoices(
  list: typeof listAtlassianConnectors,
  initiallyBound: boolean,
): {
  pods: readonly PodChoice[];
  loading: boolean;
  failed: boolean;
  reload: () => void;
} {
  const [pods, setPods] = useState<readonly PodChoice[]>([]);
  const [loading, setLoading] = useState(initiallyBound);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(initiallyBound ? 1 : 0);
  useEffect(() => {
    if (version === 0) return;
    let active = true;
    void list()
      .then((items) => {
        if (active) setPods(podChoices(items));
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [list, version]);
  useConnectorRefresh(() => {
    setLoading(true);
    setFailed(false);
    setVersion((value) => value + 1);
  });
  return {
    pods,
    loading,
    failed,
    reload: (): void => {
      setLoading(true);
      setFailed(false);
      setVersion((value) => value + 1);
    },
  };
}

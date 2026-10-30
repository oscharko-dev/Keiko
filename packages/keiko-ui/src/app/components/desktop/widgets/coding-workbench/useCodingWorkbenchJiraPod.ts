"use client";

import { useState } from "react";

import { listAtlassianConnectors } from "@/lib/atlassian-connectors-api";

import { usePodChoices, type PodChoice } from "../../useJiraPodChoices";

/**
 * The Jira Pod the human picks for the next run (owner decision 2026-10-30). The pick is shown in
 * the composer and sent with the start; the server alone decides whether it is the caller's own,
 * ready Pod. It is never remembered beyond this window, and it only counts while the Pod is still
 * offered as ready, so a Pod that stopped being usable can never ride along unseen.
 */
export interface CodingWorkbenchJiraPodSelection {
  readonly choices: readonly PodChoice[];
  /** The chosen Pod's id, or the empty string for none. */
  readonly value: string;
  readonly onChange: (podId: string) => void;
}

export function useCodingWorkbenchJiraPod(list = listAtlassianConnectors): {
  /** Absent while no ready Pod exists: the composer then shows no Jira control at all. */
  readonly selection: CodingWorkbenchJiraPodSelection | undefined;
  readonly podId: string | undefined;
} {
  const catalog = usePodChoices(list, true);
  const [picked, setPicked] = useState("");
  const choices = catalog.pods.filter((pod) => pod.ready);
  const value = choices.some((pod) => pod.id === picked) ? picked : "";
  return {
    selection: choices.length === 0 ? undefined : { choices, value, onChange: setPicked },
    podId: value === "" ? undefined : value,
  };
}

import { useCallback, useState } from "react";
import type { GroundedAnswer } from "@/lib/types";
import type { RepositoryReferenceEvidence, RepositoryReferenceRoot } from "../repositoryReferences";

export function useConnectedEvidenceReferences(
  answer: GroundedAnswer | undefined,
  roots: readonly RepositoryReferenceRoot[],
): {
  readonly evidence: RepositoryReferenceEvidence | undefined;
  readonly onReadPaths: (runId: string, paths: readonly string[]) => void;
} {
  const connected = answer?.groundingKind === "local-knowledge" ? undefined : answer;
  const runIds =
    connected === undefined
      ? []
      : Array.from(
          new Set([
            ...(connected.evidenceRunId === undefined ? [] : [connected.evidenceRunId]),
            ...(connected.evidenceRunIds ?? []),
          ]),
        );
  const key = JSON.stringify([
    connected?.assistantMessageId,
    runIds,
    roots.map((root) => root.root),
  ]);
  const runKey = JSON.stringify(runIds);
  const [snapshot, setSnapshot] = useState<{
    readonly key: string;
    readonly byRun: Readonly<Record<string, readonly string[]>>;
  }>({ key: "", byRun: {} });
  const onReadPaths = useCallback(
    (runId: string, paths: readonly string[]): void => {
      const allowed: readonly string[] = JSON.parse(runKey) as readonly string[];
      if (!allowed.includes(runId)) return;
      setSnapshot((previous) => ({
        key,
        byRun: { ...(previous.key === key ? previous.byRun : {}), [runId]: paths },
      }));
    },
    [key, runKey],
  );
  return {
    evidence:
      connected === undefined
        ? undefined
        : {
            citations: connected.citations,
            readPaths:
              snapshot.key === key ? Array.from(new Set(Object.values(snapshot.byRun).flat())) : [],
          },
    onReadPaths,
  };
}

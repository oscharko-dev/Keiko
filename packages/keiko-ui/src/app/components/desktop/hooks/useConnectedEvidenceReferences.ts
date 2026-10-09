import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const primaryId = connected?.evidenceRunId;
  const otherIds = connected?.evidenceRunIds;
  const runIds = useMemo(
    () =>
      Array.from(new Set([...(primaryId === undefined ? [] : [primaryId]), ...(otherIds ?? [])])),
    [primaryId, otherIds],
  );
  const key = JSON.stringify([
    connected?.assistantMessageId,
    runIds,
    roots.map((root) => root.root),
  ]);
  const currentKey = useRef(key);
  useEffect(() => {
    currentKey.current = key;
  }, [key]);
  const [snapshot, setSnapshot] = useState<{
    readonly key: string;
    readonly byRun: Readonly<Record<string, readonly string[]>>;
  }>({ key: "", byRun: {} });
  const onReadPaths = useCallback(
    (runId: string, paths: readonly string[]): void => {
      if (currentKey.current !== key || !runIds.includes(runId)) return;
      setSnapshot((previous) => ({
        key,
        byRun: { ...(previous.key === key ? previous.byRun : {}), [runId]: paths },
      }));
    },
    [key, runIds],
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

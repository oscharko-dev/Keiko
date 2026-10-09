import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroundedAnswer } from "@/lib/types";
import type { RepositoryReferenceEvidence, RepositoryReferenceRoot } from "../repositoryReferences";

interface ReadSource {
  readonly paths: readonly string[];
  readonly sourceScopeFingerprint: string | undefined;
}

function inspectedEvidence(
  citations: RepositoryReferenceEvidence["citations"],
  sources: readonly ReadSource[],
  roots: readonly RepositoryReferenceRoot[],
): RepositoryReferenceEvidence {
  const readPaths = sources
    .filter(
      (source) =>
        roots.filter(
          (root) =>
            source.sourceScopeFingerprint !== undefined &&
            root.scopeFingerprints?.includes(source.sourceScopeFingerprint) === true,
        ).length === 1,
    )
    .flatMap((source) => source.paths);
  return {
    citations,
    readPaths: Array.from(new Set(readPaths)),
    inspectedPaths: sources.flatMap((source) =>
      source.paths.map((scopePath) => ({
        scopePath,
        sourceScopeFingerprint: source.sourceScopeFingerprint,
      })),
    ),
  };
}

interface ConnectedEvidenceReferences {
  readonly evidence: RepositoryReferenceEvidence | undefined;
  readonly onReadPaths: (
    runId: string,
    paths: readonly string[],
    sourceScopeFingerprint?: string,
  ) => void;
}

interface ReadSnapshot {
  readonly key: string;
  readonly byRun: Readonly<Record<string, ReadSource>>;
}

export function useConnectedEvidenceReferences(
  answer: GroundedAnswer | undefined,
  roots: readonly RepositoryReferenceRoot[],
): ConnectedEvidenceReferences {
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
  const [snapshot, setSnapshot] = useState<ReadSnapshot>({ key: "", byRun: {} });
  const onReadPaths = useCallback(
    (runId: string, paths: readonly string[], sourceScopeFingerprint?: string): void => {
      if (currentKey.current !== key || !runIds.includes(runId)) return;
      setSnapshot((previous) => ({
        key,
        byRun: {
          ...(previous.key === key ? previous.byRun : {}),
          [runId]: { paths, sourceScopeFingerprint },
        },
      }));
    },
    [key, runIds],
  );
  return {
    evidence:
      connected === undefined
        ? undefined
        : inspectedEvidence(
            connected.citations,
            snapshot.key === key ? Object.values(snapshot.byRun) : [],
            roots,
          ),
    onReadPaths,
  };
}

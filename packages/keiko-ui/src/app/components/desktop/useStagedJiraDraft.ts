"use client";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import type { JiraStagedDraft } from "@/lib/atlassian-connectors-api";

// A large backlog draft is staged on the server in pages; its `jira.draft` call then carries only the
// draft's id and digest (#4178). The human still reviews every item, so the card reads them from the
// server for exactly that digest.
export type StagedJiraDraft =
  | { readonly status: "inline"; readonly args: unknown }
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly args: { readonly items: readonly unknown[] } };

interface Reference {
  readonly draftId: string;
  readonly draftDigest: string;
}
function referenceOf(args: unknown): Reference | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args) || "items" in args)
    return undefined;
  const { draftId, draftDigest } = args as Record<string, unknown>;
  return typeof draftId === "string" && typeof draftDigest === "string"
    ? { draftId, draftDigest }
    : undefined;
}

interface Loaded {
  readonly key: string;
  readonly items?: readonly unknown[];
}

export function useStagedJiraDraft(input: {
  readonly enabled: boolean;
  readonly chatId: string;
  readonly args: unknown;
  readonly load: (draftId: string, chatId: string, digest: string) => Promise<JiraStagedDraft>;
}): StagedJiraDraft {
  const { enabled, chatId, args, load } = input;
  const reference = useMemo(() => (enabled ? referenceOf(args) : undefined), [enabled, args]);
  const key =
    reference === undefined ? "" : `${chatId}:${reference.draftId}:${reference.draftDigest}`;
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    if (reference === undefined) return undefined;
    let active = true;
    load(reference.draftId, chatId, reference.draftDigest).then(
      (draft) => {
        if (active) setLoaded({ key, items: draft.items });
      },
      (error: unknown) => {
        reportClientDiagnostic("Jira draft could not be read for review.", {
          kind: "other",
          correlationId: error instanceof ApiError ? error.correlationId : undefined,
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
        if (active) setLoaded({ key });
      },
    );
    return (): void => {
      active = false;
    };
  }, [key, reference, chatId, load]);
  return useMemo((): StagedJiraDraft => {
    if (reference === undefined) return { status: "inline", args };
    if (loaded?.key !== key) return { status: "loading" };
    return loaded.items === undefined
      ? { status: "unavailable" }
      : { status: "ready", args: { items: loaded.items } };
  }, [reference, args, loaded, key]);
}

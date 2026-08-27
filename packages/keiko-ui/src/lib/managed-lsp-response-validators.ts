import {
  parseManagedLspControlMutationResponse,
  parseManagedLspControlResponse,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-route";

type ManagedLspResponseValidation =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

type ManagedLspResponseValidator = (value: unknown) => ManagedLspResponseValidation;
type ManagedLspFetch = <T>(
  path: string,
  init: RequestInit | undefined,
  validator: ManagedLspResponseValidator,
) => Promise<T>;

function validateSettings(value: unknown): ManagedLspResponseValidation {
  const parsed = parseManagedLspControlResponse(value);
  return parsed.ok ? { ok: true } : { ok: false, reasons: parsed.errors };
}

function validateMutation(value: unknown): ManagedLspResponseValidation {
  const parsed = parseManagedLspControlMutationResponse(value);
  return parsed.ok ? { ok: true } : { ok: false, reasons: parsed.errors };
}

export const managedLspApi = {
  settings<T>(fetchJson: ManagedLspFetch, root: string, signal?: AbortSignal): Promise<T> {
    const path = `/api/editor/lsp/settings?root=${encodeURIComponent(root)}`;
    return fetchJson<T>(path, { ...(signal === undefined ? {} : { signal }) }, validateSettings);
  },
  mutation<T>(
    fetchJson: ManagedLspFetch,
    input: unknown,
    etag: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return fetchJson<T>(
      "/api/editor/lsp/settings",
      {
        method: "PUT",
        headers: { "If-Match": etag, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      },
      validateMutation,
    );
  },
} as const;

import { expect, type APIRequestContext } from "@playwright/test";

// Kept out of editorWorkspace.ts on purpose: that file is a member of the D12 measurement toolchain
// digest (scripts/d12-measurement-toolchain.mjs), so any byte change there makes the committed
// editor performance evidence stale, even for a helper the measuring specs never call (PR #4095).

/**
 * Assert the server still reports `root` as restricted. Opening a root (ADR-0147 as amended by PR
 * #3685) never grants trust, so a journey that opens a revoked root asserts the server-owned state
 * rather than the absence of a prompt alone.
 */
export async function expectEditorWorkspaceRestricted(
  request: APIRequestContext,
  root: string,
): Promise<void> {
  const response = await request.get("/api/editor/verification/trust", {
    params: { projectId: root },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()) as { readonly trust: string }).toMatchObject({
    trust: "restricted",
  });
}

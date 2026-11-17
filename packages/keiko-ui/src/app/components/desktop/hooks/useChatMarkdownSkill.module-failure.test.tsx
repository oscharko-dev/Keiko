import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MarkdownSkillSelectionView } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  chatSkillBlocksSend,
  expectedMarkdownSkillSelection,
  useChatMarkdownSkill,
} from "./useChatMarkdownSkill";

const skills = vi.hoisted(() => ({ read: vi.fn() }));
const approvalModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("@/lib/browser-approval-api", () => {
  approvalModule.loads += 1;
  throw new TypeError("SYNTHETIC_MODULE_LOAD_DETAIL");
});
vi.mock("@/lib/markdown-skills-api", () => ({ fetchMarkdownSkillSelection: skills.read }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("@/lib/coding-app-session-client", () => ({
  useCodingAppSessionRedemptions: (): number => 0,
}));

afterEach(cleanup);

it("preserves selected-skill protection when the approval module itself fails to load", async () => {
  const selected: MarkdownSkillSelectionView = {
    availability: "available",
    name: "Synthetic selected skill",
    selection: {
      revision: 7,
      skill: { id: "synthetic-skill", revision: 2, digest: "a".repeat(64) },
    },
  };
  skills.read
    .mockResolvedValueOnce(selected)
    .mockRejectedValueOnce(new ApiError("NOT_FOUND", "Not found", 404));
  const hook = renderHook(() => useChatMarkdownSkill("synthetic-chat"));
  await waitFor(() => expect(hook.result.current.view).toBe(selected));
  expect(approvalModule.loads).toBe(0);
  await act(async () => hook.result.current.refresh());

  expect(approvalModule.loads).toBe(1);
  expect(hook.result.current.view).toBe(selected);
  expect(hook.result.current).toMatchObject({
    failed: true,
    busy: false,
    requireNoSkill: false,
    connectionRequired: false,
  });
  expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
  expect(expectedMarkdownSkillSelection(hook.result.current)).toBe(7);
  expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
    "Private skill selection request failed.",
    {
      correlationId: undefined,
      errorKind: "unknown",
      errorEvidence: { errorClass: "Error", frames: [], causeChain: ["TypeError"] },
    },
  );
  expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
    "SYNTHETIC_MODULE_LOAD_DETAIL",
  );
});

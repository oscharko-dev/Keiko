// #4335 — connecting a source to a pod must leave visible feedback. The page re-read after the
// connect POST used to swap the whole pod view for its loading state, unmounting the form and
// dropping any confirmation; sources only live in the collapsed Advanced section, so the person
// saw an emptied path field and nothing else.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CapsuleHealth,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { CapsuleDetail as CapsuleDetailData } from "@/lib/local-knowledge-api";
import { CapsuleDetail } from "./capsule-detail";

const connectCapsuleSourceMock = vi.fn();

vi.mock("@/lib/local-knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-knowledge-api")>();
  return {
    ...actual,
    connectCapsuleSource: (
      ...args: Parameters<typeof actual.connectCapsuleSource>
    ): ReturnType<typeof actual.connectCapsuleSource> =>
      connectCapsuleSourceMock(...args) as ReturnType<typeof actual.connectCapsuleSource>,
  };
});

vi.mock("@/lib/native-file-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/native-file-dialog")>();
  return {
    ...actual,
    nativeFileDialogSupported: vi.fn((): Promise<boolean> => Promise.resolve(false)),
  };
});

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }): React.ReactNode => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: (): URLSearchParams => new URLSearchParams("capsuleId=cap-test-1"),
  useRouter: (): { push: () => void; replace: () => void } => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: (): string => "/local-knowledge/capsule",
}));

const ID = "cap-test-1" as KnowledgeCapsuleId;

const CAPSULE = {
  id: ID,
  displayName: "Fresh Pod",
  tags: [],
  sourceIds: [],
  retrievalEffort: "default",
  outputMode: "snippets",
  answerGroundingPolicy: "require-citations",
  embeddingModelIdentity: {
    provider: "openai",
    modelId: "m",
    vectorDimensions: 8,
    vectorMetric: "cosine",
  },
  lifecycleState: "draft",
  storageReference: "capsules/cap-test-1",
  createdAt: 1,
  updatedAt: 1,
} as unknown as KnowledgeCapsule;

const HEALTH = {
  capsuleId: ID,
  sourceIds: [],
  lifecycleState: "draft",
  storageSizeBytes: 0,
  documentCount: 0,
  chunkCount: 0,
  vectorCount: 0,
  embeddingIdentity: CAPSULE.embeddingModelIdentity,
  vectorCompatible: true,
  embeddingCompatibility: {
    status: "compatible",
    reason: "current-model-matches-pinned",
    pinnedModelId: "m",
    pinnedProvider: "openai",
    pinnedVectorDimensions: 8,
    pinnedVectorMetric: "cosine",
    currentModelId: "m",
    currentProvider: "openai-compatible:test",
    message: "The pinned embedding model is configured for embeddings.",
  },
  failedDocuments: 0,
  skippedDocuments: 0,
  unsupportedDocuments: 0,
  unsupportedGuidanceCodes: [],
  staleReasons: [],
} as unknown as CapsuleHealth;

const EMPTY_POD: CapsuleDetailData = {
  capsule: CAPSULE,
  health: HEALTH,
  sources: [],
  parserDiagnostics: [],
  indexingJobs: [],
};

const CONNECTED_POD: CapsuleDetailData = {
  ...EMPTY_POD,
  sources: [
    {
      sourceId: "src-1",
      displayName: "Docs",
      scope: { kind: "folder", rootPath: "/tmp/docs", recursive: true },
      indexedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    },
  ],
};

beforeEach(() => {
  connectCapsuleSourceMock.mockReset();
});

describe("CapsuleDetail — connect a source (#4335)", () => {
  it("confirms the connection, keeps the page mounted and offers Index now", async () => {
    const user = userEvent.setup();
    connectCapsuleSourceMock.mockResolvedValue({ capsule: CAPSULE });
    let releaseReread: (detail: CapsuleDetailData) => void = () => undefined;
    const fetchDetailImpl = vi
      .fn<() => Promise<CapsuleDetailData>>()
      .mockResolvedValueOnce(EMPTY_POD)
      .mockReturnValueOnce(
        new Promise<CapsuleDetailData>((resolve) => {
          releaseReread = resolve;
        }),
      )
      .mockResolvedValue(CONNECTED_POD);
    render(<CapsuleDetail fetchDetailImpl={fetchDetailImpl} />);

    await user.type(await screen.findByLabelText(/source path/i), "/tmp/docs");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    // While the page re-reads the pod it stays on screen and already confirms the connection.
    expect(await screen.findByText(/next step: index it/i)).toHaveTextContent("/tmp/docs");
    expect(screen.getByRole("heading", { level: 1, name: "Fresh Pod" })).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();

    releaseReread(CONNECTED_POD);
    const indexButton = await screen.findByRole("button", {
      name: /index this knowledge pod now/i,
    });
    await waitFor(() => expect(indexButton).toHaveFocus());
  });

  it("keeps a failed connect visible and shows no confirmation", async () => {
    const user = userEvent.setup();
    connectCapsuleSourceMock.mockRejectedValue(new Error("Path is outside the workspace"));
    render(<CapsuleDetail fetchDetailImpl={() => Promise.resolve(EMPTY_POD)} />);

    await user.type(await screen.findByLabelText(/source path/i), "/nope");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/outside the workspace/i);
    expect(screen.queryByText(/next step: index it/i)).toBeNull();
  });

  it("keeps the pod view and shows a failed re-read inline instead of an error page", async () => {
    const user = userEvent.setup();
    connectCapsuleSourceMock.mockResolvedValue({ capsule: CAPSULE });
    const fetchDetailImpl = vi
      .fn<() => Promise<CapsuleDetailData>>()
      .mockResolvedValueOnce(EMPTY_POD)
      .mockRejectedValueOnce(new Error("Re-read unavailable"))
      .mockResolvedValue(CONNECTED_POD);
    render(<CapsuleDetail fetchDetailImpl={fetchDetailImpl} />);

    await user.type(await screen.findByLabelText(/source path/i), "/tmp/docs");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/re-read unavailable/i);
    expect(screen.getByRole("heading", { level: 1, name: "Fresh Pod" })).toBeInTheDocument();
    expect(screen.getByText(/next step: index it/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

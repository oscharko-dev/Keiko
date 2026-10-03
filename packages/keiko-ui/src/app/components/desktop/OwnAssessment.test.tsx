import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import {
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
} from "@/lib/install-client-diagnostics";
import { AssessedAnswerBody } from "./OwnAssessment";

afterEach(() => {
  resetClientDiagnosticWriter();
  resetClientDiagnosticPostStateForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBody(content: string, messageId = "msg-assessment-0001"): void {
  render(
    <AssessedAnswerBody
      content={content}
      messageId={messageId}
      repositoryRoots={[]}
      openRepositoryReference={undefined}
      citationPreview={undefined}
    />,
  );
}

describe("AssessedAnswerBody (ADR-0144)", () => {
  it("renders the cited part and Keiko's own assessment as a labelled note", () => {
    renderBody(
      "The documents set no Java version [1].\n\n<assessment>\nMine: Java 21.\n</assessment>",
    );

    expect(screen.getByText(/The documents set no Java version/)).toBeInTheDocument();
    const note = screen.getByRole("note", { name: /own assessment/i });
    expect(note).toHaveTextContent("Mine: Java 21.");
    expect(note).toHaveTextContent(/not from the sources/i);
  });

  it("keeps a literal tag inside code as written and shows no note for it", () => {
    renderBody("The XML element is `<assessment>` [1].");

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("<assessment>")).toBeInTheDocument();
  });

  // PR #3678 review: the assessment's layout evidence posts under the message's own, valid
  // correlation through the real transport, with the part named in the message identity.
  it("posts the assessment's layout evidence under the message correlation", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setClientDiagnosticWriter(fanOutClientDiagnostic);

    renderBody("Fact [1].\n\n<assessment>\n3. Mine\n</assessment>");

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    );
    expect(bodies).toContainEqual(
      expect.objectContaining({
        correlationId: "msg-assessment-0001",
        markdownLayout: {
          listStart: 3,
          listIndex: 0,
          depth: 0,
          messageId: "msg-assessment-0001:assessment",
        },
      }),
    );
  });
});

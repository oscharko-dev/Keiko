// Scripted-engine entry for the #2387 governed-research Coding Workbench journey. Shared
// composition lives in coding-runtime-server-shared.mts; the research seams (hermetic transport,
// read-only child, injection directive, tool-call log) are declared once through the shared entry's
// `research` config field.

import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

// Constants only. This entry does NOT compose the boot path — the shared entry does — and the
// architecture regression at tests/architecture/coding-runtime-shared-composition.test.ts enforces
// that no seam primitive (buildUiHandlerDeps, createFunctionalRuntimeResolver, scriptedResponse,
// scriptedTranscript, …) leaks in here.
import { RESEARCH_JOURNEY_URL } from "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js";
import {
  RESEARCH_APP_SESSION_LAUNCHER_SECRET,
  RESEARCH_DEFAULT_UI_PORT,
  RESEARCH_FIXTURE_SOURCE,
  RESEARCH_INJECTION_DIRECTIVE,
  RESEARCH_INJECTION_PAYLOAD,
  RESEARCH_JOURNEY_HOST,
  RESEARCH_JOURNEY_REQUEST_LINE,
  researchInjectionPage,
  researchManagedWorkspaceRoot,
  researchRepositoryRoot,
  researchScriptedToolCallLog,
  researchStateDir,
} from "../support/coding-runtime-2387-research.js";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

const RESEARCH_FIXTURE_TARGET_RELATIVE_PATH = "src/example.ts";

// #2637: the granted page is hostile. It carries a visible directive that asks for a workspace
// mutation, plus the same directive hidden in a <script> body and an HTML comment. The scripted
// model's compliant branch produces a REAL changeset request against this fixture file, and the
// journey asserts the mutation never lands.
const RESEARCH_EDITED_CONTENT = `export const value = '${RESEARCH_INJECTION_PAYLOAD}';\n`;

// The read-only child model that production resolves through the gateway; the journey stubs it so
// no socket is ever opened.
function childResponse(): NormalizedResponse {
  return {
    modelId: "functional-model",
    content: "Read-only repository inspection complete",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "child-2387",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// The hermetic research transport: answers ONLY for the journey URL's host with a deterministic
// page body; anything else fails closed exactly like a blocked network. No socket is ever opened.
function hermeticResearchFetch(): (url: string) => Promise<Response> {
  return (url: string): Promise<Response> => {
    if (new URL(url).hostname !== RESEARCH_JOURNEY_HOST) {
      return Promise.reject(new Error("blocked-by-hermetic-transport"));
    }
    return Promise.resolve(new Response(researchInjectionPage(), { status: 200 }));
  };
}

await runCodingRuntimeJourneyServer({
  fixtureId: "research-2387",
  fixtureLabel: "research-2387",
  runtime: "scripted",
  includeQuestion: true,
  defaultPort: RESEARCH_DEFAULT_UI_PORT,
  originalContent: RESEARCH_FIXTURE_SOURCE,
  editedContent: RESEARCH_EDITED_CONTENT,
  targetRelativePath: RESEARCH_FIXTURE_TARGET_RELATIVE_PATH,
  stateDir: researchStateDir,
  repositoryRoot: researchRepositoryRoot,
  managedRoot: researchManagedWorkspaceRoot,
  launcherSessionSecret: RESEARCH_APP_SESSION_LAUNCHER_SECRET,
  research: {
    journeyUrl: RESEARCH_JOURNEY_URL,
    journeyHost: RESEARCH_JOURNEY_HOST,
    expectedRequestLine: RESEARCH_JOURNEY_REQUEST_LINE,
    injectionDirective: RESEARCH_INJECTION_DIRECTIVE,
    hermeticFetch: hermeticResearchFetch,
    childModelResponse: childResponse,
    childModelId: "functional-model",
    toolCallLogPath: researchScriptedToolCallLog,
  },
});

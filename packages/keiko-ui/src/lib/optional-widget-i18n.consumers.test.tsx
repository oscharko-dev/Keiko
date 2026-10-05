import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider, I18N_STORAGE_KEY } from "./i18n";
import { useOptionalWidgetTranslate } from "./optional-widget-i18n";
import { fetchFilesContent, fetchEditorLanguageCapabilities } from "./api";
import EditorRuntimeWidget from "@/app/components/desktop/widgets/cards/EditorRuntimeWidget";
import type { EditorSurfaceProps } from "@/app/components/desktop/widgets/cards/EditorSurface";
import { PromptEnhancerPanel } from "@/app/components/desktop/widgets/panels/PromptEnhancerPanel";
import { PdfCitationPreviewWindow } from "@/app/components/desktop/widgets/cards/PdfCitationPreviewWindow";

const catalog = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
});

vi.mock("./i18n-messages.optional.de", async (importOriginal) => {
  await catalog.gate;
  return importOriginal<typeof import("./i18n-messages.optional.de")>();
});

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchFilesContent: vi.fn(),
  fetchEditorLanguageCapabilities: vi.fn(),
  fetchGitStatus: vi.fn(async () => ({ available: false })),
  postEditorBufferSafetyRequest: vi.fn(async () => ({ snapshot: null })),
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function EditorSurfaceProbe(props: EditorSurfaceProps): ReactNode {
      return <output aria-label="Call hierarchy title">{props.callHierarchyLabels?.title}</output>;
    },
}));

const effect = vi.fn();
const fetchModels = vi.fn(async () => ({ models: [] }));

function TranslatorEffect(): ReactNode {
  const t = useOptionalWidgetTranslate();
  useEffect(effect, [t]);
  return null;
}

function mountConsumers(): void {
  render(
    <I18nProvider>
      <TranslatorEffect />
      <EditorRuntimeWidget root="/repo" file="src/app.ts" />
      <PromptEnhancerPanel fetchModelsImpl={fetchModels} />
      <PdfCitationPreviewWindow
        cfg={{}}
        focusWindow={vi.fn()}
        updateCfg={vi.fn()}
        windowId="locale-preview"
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  catalog.release();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

it("refreshes memoized consumer labels after delayed German loading without repeating reads", async () => {
  window.localStorage.setItem(I18N_STORAGE_KEY, "de");
  vi.mocked(fetchFilesContent).mockResolvedValue({
    root: "/repo",
    path: "src/app.ts",
    name: "app.ts",
    sizeBytes: 17,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: "const value = 1;\n",
    maxBytes: 1_000_000,
    session: {
      schemaVersion: "1",
      version: { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) },
    },
  });
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue({
    schemaVersion: "1",
    providers: [
      {
        id: "typescript",
        languages: ["typescript"],
        operations: ["callHierarchy"],
        availability: "available",
      },
    ],
  });
  mountConsumers();
  await waitFor(() => expect(document.documentElement.lang).toBe("de"));
  await waitFor(() =>
    expect(screen.getByLabelText("Call hierarchy title")).toHaveTextContent("Call hierarchy"),
  );
  expect(screen.getByText("No connected Files source")).toBeVisible();
  expect(screen.getByRole("heading", { name: "PDF Preview" })).toBeVisible();
  const effectsBeforeLoad = effect.mock.calls.length;
  const readsBeforeLoad = vi.mocked(fetchFilesContent).mock.calls.length;
  await act(async () => {
    catalog.release();
    await catalog.gate;
  });
  await screen.findByText("Grounding-Kontext");
  expect.soft(screen.getByLabelText("Call hierarchy title")).toHaveTextContent("Aufrufhierarchie");
  expect.soft(screen.queryByText("Keine verbundene Datei-Quelle")).toBeVisible();
  expect.soft(screen.queryByRole("heading", { name: "PDF-Vorschau" })).toBeVisible();
  expect(effect).toHaveBeenCalledTimes(effectsBeforeLoad);
  expect(fetchFilesContent).toHaveBeenCalledTimes(readsBeforeLoad);
  expect(fetchModels).toHaveBeenCalledTimes(1);
});

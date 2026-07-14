import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { SettingsPanel } from "./SettingsPanel";

const fetchConfigMock = vi.fn();
const fetchModelsMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchConfig: (): Promise<unknown> => fetchConfigMock(),
  fetchModels: (): Promise<unknown> => fetchModelsMock(),
  runGatewayReadiness: (): Promise<unknown> => Promise.resolve(undefined),
}));

vi.mock("./DebuggingSettings", () => ({
  DebuggingSettings: ({ root }: { readonly root?: string | undefined }) => (
    <div data-testid="debugging-settings-surface">{root ?? "no-workspace"}</div>
  ),
}));

vi.mock("./ManagedLanguageSettings", () => ({
  ManagedLanguageSettings: () => null,
}));

vi.mock("./EditorSettingsPanel", () => ({
  EditorSettingsPanel: () => null,
}));

describe("SettingsPanel debugging tab", () => {
  it("renders the translated Debugging tab and composes the scoped surface", () => {
    fetchConfigMock.mockResolvedValue({ config: null, configPresent: false });
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(
      <I18nProvider>
        <SettingsPanel root="/workspace/debug" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Debugging" }));

    expect(screen.getByTestId("debugging-settings-surface")).toHaveTextContent("/workspace/debug");
  });
});

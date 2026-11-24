import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import {
  appDataReasonForRoot,
  appDataReasonForScope,
  ChatAppDataNotice,
  FilesAppDataNotice,
} from "./AppDataNotice";

const PROFILE = "C:\\Users\\person";

function scope(overrides: Partial<ChatConnectedScope> = {}): ChatConnectedScope {
  return {
    kind: "workspace-root",
    root: PROFILE,
    relativePaths: [],
    connectedAtMs: 1,
    ...overrides,
  };
}

function chat(connected: ChatConnectedScope, id = "chat-a"): Chat {
  return {
    id,
    projectPath: PROFILE,
    title: "Chat",
    selectedModel: "model",
    branchLabel: undefined,
    status: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    connectedScope: connected,
    groundingScopeIdentity: "identity",
  };
}

function directory(name: string): {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory";
  readonly extension: null;
  readonly readable: true;
} {
  return { name, path: name, kind: "directory", extension: null, readable: true };
}

afterEach(() => {
  resetClientDiagnosticWriter();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("AppData notice detection (#4437)", () => {
  it.each([
    ["C:\\Users\\person\\AppData", undefined, "app-data-selected"],
    ["C:/Users/person/appdata/Local/", undefined, "app-data-selected"],
    ["C:\\Users\\person", undefined, "app-data-contained"],
    ["c:\\users", undefined, "app-data-contained"],
    ["D:\\Archive", ["Documents", "AppData"], "app-data-contained"],
    ["C:\\Users\\person", ["Documents"], undefined],
    ["C:\\Users\\person\\Documents", undefined, undefined],
    ["/home/person", undefined, undefined],
    ["D:\\AppDataBackup", ["MyAppData", "appdata.txt"], undefined],
    ["", undefined, undefined],
  ] as const)("judges root %s with listing %j as %s", (root, children, expected) => {
    expect(appDataReasonForRoot(root, children)).toBe(expected);
  });

  it("judges a selected subfolder by its own path", () => {
    expect(
      appDataReasonForScope(scope({ kind: "directory", relativePaths: ["AppData/Roaming"] })),
    ).toBe("app-data-selected");
    expect(
      appDataReasonForScope(scope({ kind: "directory", relativePaths: ["Documents"] })),
    ).toBeUndefined();
    expect(
      appDataReasonForScope(scope({ kind: "files", relativePaths: ["Desktop/a.txt"] })),
    ).toBeUndefined();
    const { root: _root, ...withoutRoot } = scope();
    expect(appDataReasonForScope(withoutRoot)).toBeUndefined();
  });
});

describe("ChatAppDataNotice (#4437)", () => {
  it("informs in English without blocking and records only the closed reason", async () => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(<ChatAppDataNotice chat={chat(scope())} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/This folder contains AppData/u);
    expect(note).toHaveTextContent(/browser profiles, mailboxes and saved sign-ins/u);
    expect(screen.queryByRole("button")).toBeNull();
    expect(await axe(view.container)).toHaveNoViolations();
    view.rerender(<ChatAppDataNotice chat={{ ...chat(scope()), updatedAt: 9 }} />);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({
      scopeNotice: { reason: "app-data-contained", scopeKind: "workspace-root", pathCount: 0 },
    });
    const recorded = JSON.stringify(diagnostic.mock.calls);
    expect(recorded).not.toContain("Users");
    expect(recorded).not.toContain("person");
  });

  it("speaks German when the locale is German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <ChatAppDataNotice
          chat={chat(scope({ kind: "directory", relativePaths: ["AppData/Local"] }))}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText(/Dieser Ordner gehört zu AppData/u)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Browserprofile, Postfächer/u);
  });

  it("shows nothing and records nothing for an ordinary folder", () => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const view = render(
      <ChatAppDataNotice chat={chat(scope({ root: "C:\\Users\\person\\Documents" }))} />,
    );
    expect(view.container).toBeEmptyDOMElement();
    expect(diagnostic).not.toHaveBeenCalled();
  });
});

describe("FilesAppDataNotice (#4437)", () => {
  it("shows the notice when the opened root lists an AppData folder", () => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    render(
      <FilesAppDataNotice
        root="D:\\Archive"
        path=""
        entries={[directory("Documents"), directory("AppData")]}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(/This folder contains AppData/u);
    expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({
      scopeNotice: { reason: "app-data-contained", scopeKind: "workspace-root", pathCount: 0 },
    });
  });

  it("stays silent below the root, while loading and for a profile without AppData", () => {
    const entries = [directory("AppData")];
    const nested = render(<FilesAppDataNotice root={PROFILE} path="Documents" entries={entries} />);
    expect(nested.container).toBeEmptyDOMElement();
    const loading = render(<FilesAppDataNotice root={PROFILE} path="" entries={undefined} />);
    expect(loading.container).toBeEmptyDOMElement();
    const listed = render(
      <FilesAppDataNotice root={PROFILE} path="" entries={[directory("Documents")]} />,
    );
    expect(listed.container).toBeEmptyDOMElement();
  });
});

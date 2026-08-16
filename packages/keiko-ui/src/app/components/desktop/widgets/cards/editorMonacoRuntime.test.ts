import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy browser-only modules: Monaco's ESM entry imports browser/CSS modules, and the
// loader's CDN config must not run for real. The keiko-editor helpers stay real — they are pure and
// node-safe — so this exercises the host's actual wiring decisions.
const config = vi.fn();
interface MonacoLanguageSummary {
  readonly id: string;
}

const getLanguages = vi.fn<() => MonacoLanguageSummary[]>(() => []);
const registerLanguage = vi.fn();

// Side-effect-only basic-languages contributions register the language id + Monarch grammar for
// css/scss/less/html (ADR-0068 D5). The bootstrap module must import all four; each factory records
// its evaluation so the test can assert the import graph pins them.
const basicLanguageImports = new Set<string>();
function trackBasicLanguageImport(languageId: string): Record<string, never> {
  basicLanguageImports.add(languageId);
  return {};
}
const editorFeatureImports = new Set<string>();
function trackEditorFeatureImport(featureId: string): Record<string, never> {
  editorFeatureImports.add(featureId);
  return {};
}
const optionalLanguageImports = new Set<string>();
function trackOptionalLanguageImport(languageId: string): Record<string, never> {
  optionalLanguageImports.add(languageId);
  return {};
}

vi.mock("@monaco-editor/react", () => ({ loader: { config } }));
vi.mock("monaco-editor/editor/editor.api.js", () => ({
  editor: {},
  languages: {
    getLanguages,
    register: registerLanguage,
  },
}));
vi.mock("monaco-editor/features/hover/register.js", () => trackEditorFeatureImport("hover"));
vi.mock("monaco-editor/features/inlineCompletions/register.js", () =>
  trackEditorFeatureImport("inlineCompletions"),
);
vi.mock("monaco-editor/features/quickCommand/register.js", () =>
  trackEditorFeatureImport("quickCommand"),
);
vi.mock("monaco-editor/features/quickHelp/register.js", () =>
  trackEditorFeatureImport("quickHelp"),
);
vi.mock("monaco-editor/features/suggest/register.js", () => trackEditorFeatureImport("suggest"));
vi.mock("monaco-editor/languages/definitions/go/register.js", () =>
  trackOptionalLanguageImport("go"),
);
vi.mock("monaco-editor/languages/definitions/java/register.js", () =>
  trackOptionalLanguageImport("java"),
);
vi.mock("monaco-editor/languages/definitions/javascript/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/markdown/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/python/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/rust/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/shell/register.js", () =>
  trackOptionalLanguageImport("shell"),
);
vi.mock("monaco-editor/languages/definitions/sql/register.js", () =>
  trackOptionalLanguageImport("sql"),
);
vi.mock("monaco-editor/languages/definitions/typescript/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/yaml/register.js", () => ({}));
vi.mock("monaco-editor/languages/definitions/css/register.js", () =>
  trackBasicLanguageImport("css"),
);
vi.mock("monaco-editor/languages/definitions/scss/register.js", () =>
  trackBasicLanguageImport("scss"),
);
vi.mock("monaco-editor/languages/definitions/less/register.js", () =>
  trackBasicLanguageImport("less"),
);
vi.mock("monaco-editor/languages/definitions/html/register.js", () =>
  trackBasicLanguageImport("html"),
);
vi.mock("monaco-editor/esm/vs/language/css/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/esm/vs/language/html/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/esm/vs/language/json/monaco.contribution.js", () => ({}));

interface MutableScope {
  Worker?: unknown;
  MonacoEnvironment?: unknown;
}

const scope = globalThis as unknown as MutableScope;

beforeEach(() => {
  vi.resetModules();
  config.mockClear();
  getLanguages.mockClear();
  getLanguages.mockReturnValue([]);
  registerLanguage.mockClear();
  delete scope.Worker;
  delete scope.MonacoEnvironment;
});

afterEach(() => {
  delete scope.Worker;
  delete scope.MonacoEnvironment;
});

describe("ensureMonacoRuntime", () => {
  it("reports an unsupported runtime and configures nothing when Web Workers are unavailable", async () => {
    // jsdom has no Worker constructor by default — the real unsupported path.
    const { ensureMonacoRuntime } = await import("./editorMonacoRuntime");
    const status = ensureMonacoRuntime();
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("web-workers-unavailable");
    }
    expect(config).not.toHaveBeenCalled();
    expect(registerLanguage).not.toHaveBeenCalled();
    expect(scope.MonacoEnvironment).toBeUndefined();
  });

  it("installs the worker environment, no-CDN loader, and governed language ids exactly once when supported", async () => {
    scope.Worker = class {};
    const { ensureMonacoRuntime } = await import("./editorMonacoRuntime");

    const first = ensureMonacoRuntime();
    expect(first.supported).toBe(true);
    expect(config).toHaveBeenCalledTimes(1);
    expect(registerLanguage).toHaveBeenCalledTimes(1);
    expect(registerLanguage).toHaveBeenCalledWith({
      aliases: ["JSON", "json"],
      extensions: [".json", ".jsonc"],
      id: "json",
      mimetypes: ["application/json", "application/jsonc"],
    });
    expect(scope.MonacoEnvironment).toBeDefined();

    // Idempotent: a second call neither reconfigures the loader nor reinstalls the environment.
    const second = ensureMonacoRuntime();
    expect(second.supported).toBe(true);
    expect(config).toHaveBeenCalledTimes(1);
    expect(registerLanguage).toHaveBeenCalledTimes(1);
  });

  it("registers the css/scss/less/html basic-languages contributions at bootstrap (ADR-0068 D5)", async () => {
    // Importing the module evaluates its side-effect contribution imports; each mock factory records
    // the language it stands in for. The factories run on first evaluation, so by the time this test
    // imports the module all four basic-languages contributions are present in the import graph.
    await import("./editorMonacoRuntime");
    expect(basicLanguageImports.has("css")).toBe(true);
    expect(basicLanguageImports.has("scss")).toBe(true);
    expect(basicLanguageImports.has("less")).toBe(true);
    expect(basicLanguageImports.has("html")).toBe(true);
  });

  it("registers the standalone editor UX features used by smoke coverage", async () => {
    await import("./editorMonacoRuntime");
    expect(editorFeatureImports).toEqual(
      new Set(["hover", "inlineCompletions", "quickCommand", "quickHelp", "suggest"]),
    );
  });

  it("keeps rare Monaco language contributions out of the eager editor runtime chunk", async () => {
    await import("./editorMonacoRuntime");
    expect(optionalLanguageImports.size).toBe(0);
  });

  it("loads optional Monaco language contributions on demand and dedupes in-flight loads", async () => {
    const {
      ensureMonacoLanguage,
      ensureMonacoLanguages,
      isMonacoLanguageReady,
      areMonacoLanguagesReady,
    } = await import("./editorMonacoRuntime");

    expect(isMonacoLanguageReady("go")).toBe(false);
    expect(isMonacoLanguageReady("typescript")).toBe(true);
    expect(areMonacoLanguagesReady(["typescript", "go"])).toBe(false);

    await Promise.all([ensureMonacoLanguage("go"), ensureMonacoLanguage("go")]);
    expect(optionalLanguageImports).toEqual(new Set(["go"]));
    expect(isMonacoLanguageReady("go")).toBe(true);

    await ensureMonacoLanguages(["go", "sql", "typescript"]);
    expect(optionalLanguageImports).toEqual(new Set(["go", "sql"]));
    expect(areMonacoLanguagesReady(["go", "sql", "typescript"])).toBe(true);
  });

  it("does not register JSON twice when Monaco already has it", async () => {
    scope.Worker = class {};
    getLanguages.mockReturnValue([{ id: "json" }]);
    const { ensureMonacoRuntime } = await import("./editorMonacoRuntime");

    expect(ensureMonacoRuntime().supported).toBe(true);
    expect(registerLanguage).not.toHaveBeenCalled();
  });
});

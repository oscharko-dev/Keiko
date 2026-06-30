// Frontend test-stack detection and convention-driven test-style selection (Issue #1203, Epic #1189,
// ADR-0042 D7). Extends the deterministic convention detection (conventions.ts) from "which base test
// framework" to "which frontend test STYLE the target warrants" — unit, component, interaction,
// accessibility smoke, or browser smoke — grounded in the project's declared test tooling and the
// target file's own shape.
//
// PURE except for the narrow filesystem seam used to read local package manifests and detect framework
// config (no clock, no RNG, no network). ALL path and content predicates use plain string ops
// (split/startsWith/endsWith/includes) — zero regex — so there is no ReDoS surface (CodeQL
// js/polynomial-redos), mirroring conventions.ts.
//
// "Prefer convention-driven generation over user prompt guessing" (Engineering Notes): the style is
// derived from the detected stack plus the target path/shape, never from a user-supplied flag. When the
// target is a frontend component but the project declares no supported frontend test stack, the
// selector returns `unsupported` so the workflow surfaces a clear, reviewable limitation instead of
// fabricating a browser/component test it cannot ground (Acceptance Criterion 5).

import { dirname, join, resolve } from "node:path";
import type { TestFramework, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

// ─── Detected frontend test stack ────────────────────────────────────────────────────────────────

export type ComponentFramework = "react" | "none";

// The frontend test tooling a project declares, derived from its package manifests and framework
// config. Every field is a content-free boolean/enum so it is safe to surface as provenance.
export interface FrontendTestStack {
  readonly componentFramework: ComponentFramework;
  // @testing-library/react — the React component-rendering test library.
  readonly hasReactTestingLibrary: boolean;
  // @testing-library/user-event — drives realistic user interactions.
  readonly hasUserEvent: boolean;
  // @testing-library/jest-dom — DOM assertion matchers.
  readonly hasJestDom: boolean;
  // jest-axe / vitest-axe / @axe-core/* / axe-core — accessibility assertion matchers.
  readonly hasAccessibilityMatchers: boolean;
  // jsdom / happy-dom — a browser-like DOM environment for component tests.
  readonly hasDomEnvironment: boolean;
  // @playwright/test / playwright — the browser end-to-end runner.
  readonly hasPlaywright: boolean;
}

export const EMPTY_FRONTEND_TEST_STACK: FrontendTestStack = {
  componentFramework: "none",
  hasReactTestingLibrary: false,
  hasUserEvent: false,
  hasJestDom: false,
  hasAccessibilityMatchers: false,
  hasDomEnvironment: false,
  hasPlaywright: false,
} as const;

// ─── Test style & strategy ───────────────────────────────────────────────────────────────────────

export type TestStyle =
  "unit" | "component" | "interaction" | "accessibility-smoke" | "browser-smoke" | "unsupported";

export const TEST_STYLES: readonly TestStyle[] = [
  "unit",
  "component",
  "interaction",
  "accessibility-smoke",
  "browser-smoke",
  "unsupported",
] as const;

// The verification runner a style's generated tests would execute under in the assured pre-filter
// (#1202/#1204). `none` when no runner applies (e.g. an unknown base framework, or an unsupported
// stack); the candidate then stays `unverified` because no oracle can run.
export type TestVerification = "vitest" | "jest" | "mocha" | "playwright" | "none";

export interface TestStrategy {
  readonly style: TestStyle;
  // A content-free, deterministic explanation of the selected style (or the limitation when
  // unsupported). Safe to surface to the user and persist as evidence.
  readonly reason: string;
  readonly verification: TestVerification;
}

// ─── Manifest parsing (pure) ─────────────────────────────────────────────────────────────────────

const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The union of dependency names declared across every dependency field of one package manifest.
// Throw-free: an unparseable or non-object manifest yields an empty set.
export function manifestDependencyNames(manifestJson: string): ReadonlySet<string> {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return names;
  }
  if (!isRecord(parsed)) {
    return names;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const block = parsed[field];
    if (isRecord(block)) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
}

// ─── Stack detection (pure over a dependency set) ──────────────────────────────────────────────────

const REACT = "react";
const RTL = "@testing-library/react";
const USER_EVENT = "@testing-library/user-event";
const JEST_DOM = "@testing-library/jest-dom";
const PLAYWRIGHT_DEPS: readonly string[] = ["@playwright/test", "playwright"];
const DOM_ENV_DEPS: readonly string[] = ["jsdom", "happy-dom"];
const AXE_DEPS: readonly string[] = [
  "jest-axe",
  "vitest-axe",
  "@axe-core/react",
  "@axe-core/playwright",
  "axe-core",
];

function hasAny(names: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => names.has(candidate));
}

export interface FrontendStackSignals {
  readonly hasPlaywrightConfig: boolean;
}

// Derives the frontend test stack from the union of declared dependency names plus framework-config
// signals. Pure and total.
export function detectFrontendStackFromDependencies(
  names: ReadonlySet<string>,
  signals: FrontendStackSignals,
): FrontendTestStack {
  return {
    componentFramework: names.has(REACT) ? "react" : "none",
    hasReactTestingLibrary: names.has(RTL),
    hasUserEvent: names.has(USER_EVENT),
    hasJestDom: names.has(JEST_DOM),
    hasAccessibilityMatchers: hasAny(names, AXE_DEPS),
    hasDomEnvironment: hasAny(names, DOM_ENV_DEPS),
    hasPlaywright: hasAny(names, PLAYWRIGHT_DEPS) || signals.hasPlaywrightConfig,
  };
}

// ─── Stack detection (filesystem seam) ─────────────────────────────────────────────────────────────

// The narrow filesystem port this module needs: existence + UTF-8 read. The node WorkspaceFs satisfies
// it structurally; tests pass a tiny in-memory fake.
export interface ManifestReaderFs {
  readonly exists: (absolutePath: string) => boolean;
  readonly readFileUtf8: (absolutePath: string) => string;
}

const MANIFEST = "package.json";
const PLAYWRIGHT_CONFIG_BASENAMES: readonly string[] = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "playwright.config.mts",
  "playwright.config.cts",
];
// A hard ceiling on the manifest walk-up so a pathological start directory cannot loop unboundedly.
const MAX_WALK_DEPTH = 16;

function readManifestNames(fs: ManifestReaderFs, dir: string): ReadonlySet<string> {
  const path = join(dir, MANIFEST);
  if (!fs.exists(path)) {
    return new Set<string>();
  }
  try {
    return manifestDependencyNames(fs.readFileUtf8(path));
  } catch {
    return new Set<string>();
  }
}

function hasPlaywrightConfigIn(fs: ManifestReaderFs, dir: string): boolean {
  return PLAYWRIGHT_CONFIG_BASENAMES.some((basename) => fs.exists(join(dir, basename)));
}

// The directories from the anchor's directory up to (and including) the workspace root, nearest first,
// never escaping the root. `anchorRelPath` is a workspace-relative target path; absent → just the root.
function manifestSearchDirs(root: string, anchorRelPath: string | undefined): readonly string[] {
  const resolvedRoot = resolve(root);
  if (anchorRelPath === undefined || anchorRelPath.length === 0) {
    return [resolvedRoot];
  }
  const dirs: string[] = [];
  let current = dirname(resolve(resolvedRoot, anchorRelPath));
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (current === resolvedRoot || !current.startsWith(`${resolvedRoot}/`)) {
      break;
    }
    dirs.push(current);
    current = dirname(current);
  }
  dirs.push(resolvedRoot);
  return dirs;
}

// Reads the project's declared frontend test tooling by unioning the dependency names of the nearest
// package manifests (target package up to the workspace root) and detecting a Playwright config. Bounded
// and throw-free; an unreadable manifest contributes nothing.
export function detectFrontendStack(
  workspace: WorkspaceInfo,
  fs: ManifestReaderFs,
  anchorRelPath?: string,
): FrontendTestStack {
  const names = new Set<string>();
  let hasPlaywrightConfig = false;
  for (const dir of manifestSearchDirs(workspace.root, anchorRelPath)) {
    for (const name of readManifestNames(fs, dir)) {
      names.add(name);
    }
    if (hasPlaywrightConfigIn(fs, dir)) {
      hasPlaywrightConfig = true;
    }
  }
  return detectFrontendStackFromDependencies(names, { hasPlaywrightConfig });
}

// ─── Target classification (pure) ──────────────────────────────────────────────────────────────────

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function lastSegment(path: string): string {
  const posix = toPosix(path);
  const idx = posix.lastIndexOf("/");
  return idx === -1 ? posix : posix.slice(idx + 1);
}

function endsWithAny(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

const COMPONENT_EXTENSIONS: readonly string[] = [".tsx", ".jsx"];

// A path that, by extension, is a React component module (`.tsx`/`.jsx`).
export function isReactComponentPath(path: string): boolean {
  return endsWithAny(toPosix(path), COMPONENT_EXTENSIONS);
}

// A best-effort, regex-free check that a `.ts`/`.js` module's source looks like a React component:
// it imports React and either returns JSX or calls React.createElement. Used only as a secondary signal
// for non-`.tsx` files; the extension is the primary signal.
export function looksLikeReactComponentSource(source: string | undefined): boolean {
  if (source === undefined || source.length === 0) {
    return false;
  }
  const importsReact =
    source.includes('from "react"') ||
    source.includes("from 'react'") ||
    source.includes('require("react")');
  if (!importsReact) {
    return false;
  }
  return source.includes("React.createElement") || source.includes("/>") || source.includes("</");
}

const PLAYWRIGHT_ENTRY_DIRS: readonly string[] = [
  "e2e/",
  "tests/e2e/",
  "playwright/",
  "app/",
  "pages/",
];
const NEXT_ROUTE_BASENAMES: readonly string[] = [
  "page.tsx",
  "page.jsx",
  "layout.tsx",
  "layout.jsx",
];

// Whether a path is an application entry point a Playwright browser smoke can meaningfully target:
// a Next.js route file (`page`/`layout`), a `*.page.*` module, or a file under a recognised end-to-end
// or app/route directory. Pure string predicates only.
export function isPlaywrightEntryPath(path: string): boolean {
  const posix = toPosix(path);
  const base = lastSegment(posix);
  if (NEXT_ROUTE_BASENAMES.includes(base)) {
    return true;
  }
  if (base.includes(".page.")) {
    return true;
  }
  return PLAYWRIGHT_ENTRY_DIRS.some((dir) => posix.startsWith(dir) || posix.includes(`/${dir}`));
}

// Identifies when a Playwright browser smoke is appropriate (AC: "identify when Playwright smoke is
// appropriate and when it is not"): only when the project declares Playwright AND the target is an
// application entry point. A plain library or in-page component is never an appropriate Playwright
// target, even when the project ships Playwright.
export function isPlaywrightSmokeAppropriate(path: string, stack: FrontendTestStack): boolean {
  return stack.hasPlaywright && isPlaywrightEntryPath(path);
}

// ─── Strategy selection (pure) ─────────────────────────────────────────────────────────────────────

export interface StrategyInput {
  // Workspace-relative path of the file under test.
  readonly targetPath: string;
  // The target file's (already redacted) source excerpt, when available. Optional secondary signal.
  readonly targetSource?: string | undefined;
  // The project's detected base test framework (conventions.framework).
  readonly framework: TestFramework;
  readonly stack: FrontendTestStack;
}

function verificationForFramework(framework: TestFramework): TestVerification {
  if (framework === "vitest" || framework === "jest" || framework === "mocha") {
    return framework;
  }
  return "none";
}

function isComponentTarget(input: StrategyInput): boolean {
  return (
    isReactComponentPath(input.targetPath) || looksLikeReactComponentSource(input.targetSource)
  );
}

const UNIT_REASON =
  "Selected unit-test style: the target is a plain TypeScript/JavaScript module, so a Playwright " +
  "browser smoke is not appropriate and a standard unit test is generated.";
const BROWSER_REASON =
  "Selected Playwright browser-smoke style: the target is an application entry point and the project " +
  "declares Playwright.";
const COMPONENT_REASON =
  "Selected component-test style: the target is a React component and the project declares " +
  "@testing-library/react.";
const INTERACTION_REASON =
  "Selected interaction-test style: the target is a React component and the project declares " +
  "@testing-library/react with @testing-library/user-event, so user interactions are exercised.";
const ACCESSIBILITY_REASON =
  "Selected accessibility-smoke style: the target is a React component and the project declares " +
  "@testing-library/react with an accessibility matcher, so an accessibility assertion is included.";
const UNSUPPORTED_REASON =
  "Unsupported stack: the target is a frontend component but the project does not declare a supported " +
  "React component-testing stack (@testing-library/react). A reviewable limitation is reported instead " +
  "of a fabricated browser or component test.";

function componentStrategy(input: StrategyInput): TestStrategy {
  const verification = verificationForFramework(input.framework);
  if (input.stack.hasAccessibilityMatchers) {
    return { style: "accessibility-smoke", reason: ACCESSIBILITY_REASON, verification };
  }
  if (input.stack.hasUserEvent) {
    return { style: "interaction", reason: INTERACTION_REASON, verification };
  }
  return { style: "component", reason: COMPONENT_REASON, verification };
}

// Selects the convention-driven test strategy for a target. Total over its input: every target maps to
// exactly one style with a stated reason and a verification runner.
//
//  1. An application entry point in a Playwright project → browser smoke.
//  2. A React component with a supported React testing stack → accessibility-smoke / interaction /
//     component (richest applicable).
//  3. A React component WITHOUT a supported stack → unsupported (a clear limitation, AC5).
//  4. Any other module → unit (a Playwright smoke is explicitly not appropriate here, AC3).
export function selectTestStrategy(input: StrategyInput): TestStrategy {
  if (isPlaywrightSmokeAppropriate(input.targetPath, input.stack)) {
    return { style: "browser-smoke", reason: BROWSER_REASON, verification: "playwright" };
  }
  if (isComponentTarget(input)) {
    if (input.stack.componentFramework !== "react" || !input.stack.hasReactTestingLibrary) {
      return { style: "unsupported", reason: UNSUPPORTED_REASON, verification: "none" };
    }
    return componentStrategy(input);
  }
  return {
    style: "unit",
    reason: UNIT_REASON,
    verification: verificationForFramework(input.framework),
  };
}

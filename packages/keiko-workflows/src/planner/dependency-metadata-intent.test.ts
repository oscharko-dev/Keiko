import { describe, expect, it } from "vitest";
import { requestsDependencyMetadata } from "./intent.js";

describe("dependency metadata intent outside preservation constraints and source data", () => {
  it.each([
    "Keep dependencies unchanged.",
    "Leave dependency versions unchanged.",
    "Don't update dependencies.",
    "Don’t update dependencies.",
    "Don't update dependencies and don't change versions.",
    "Do not change dependencies and versions.",
    "Do not change dependencies and do not change versions which are locked.",
    "Do not change dependencies and do not report which versions are installed.",
    "Do not change dependencies, but do not report which versions are installed.",
    "Keep dependencies and their versions unchanged.",
    "Fix the test without changing production code, dependencies, or accepted requirements.",
    "Ändere keine Abhängigkeiten.",
    "Bitte ändere keine Versionen der Abhängigkeiten.",
    "Lass die Versionen der Abhängigkeiten unverändert.",
    'The failed assertion is `expect(value).toBe("locked")`.',
    'The failure text is "expected version 2 but received 1".',
    "The affected source is frontend/src/version.ts.",
    "Explain this code:\n```ts\nconst version = 2;\n```",
    'Inspect "package-lock.json".',
  ])("does not infer dependency evidence from %s", (query) => {
    expect(requestsDependencyMetadata(query)).toBe(false);
  });

  it.each([
    "Which resolved React version does the frontend use?",
    "Show the transitive dependencies.",
    "Explain the package manager configuration.",
    "Which lockfile is used?",
    "Keep dependencies unchanged, but report the resolved React version.",
    "Keep dependencies unchanged and tell me which React version is resolved.",
    "Keep dependencies unchanged and explain which React version is resolved.",
    "Leave dependencies unchanged and describe the resolved React version.",
    "Do not change dependencies and tell me which React version is resolved.",
    "Don't update dependencies and explain the resolved React version.",
    "Do not change dependencies and describe the installed React version.",
    "Without changing dependencies, explain the resolved React version.",
    "Ändere keine Abhängigkeiten und erkläre, welche React-Version aufgelöst wurde.",
    "Keep dependencies unchanged and keep versions unchanged, but explain which version is resolved.",
    "Don't update dependencies and report the resolved React version.",
    "Don't update dependencies, report the resolved React version.",
    "Don't update dependencies and don't change versions, but report the resolved React version.",
    "Do not change dependency versions; report the resolved React version.",
    "Report the resolved version without changing dependencies.",
    "Why is the dependency version unchanged?",
    "Ändere keine Abhängigkeiten, aber nenne die aufgelöste React-Version.",
    "Lass die Versionen unverändert und nenne die aufgelöste React-Version.",
    "Erzeuge Tests mit den aufgelösten Versionen der Abhängigkeiten.",
    'Which React version is installed? The error says "expected version 2".',
  ])("retains an affirmative request in %s", (query) => {
    expect(requestsDependencyMetadata(query)).toBe(true);
  });
});

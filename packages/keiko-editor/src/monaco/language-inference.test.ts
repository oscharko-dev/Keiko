import { describe, expect, it } from "vitest";

import {
  MONACO_LANGUAGE_BY_EXTENSION,
  MONACO_LANGUAGE_IDS,
  MONACO_PLAINTEXT_LANGUAGE_ID,
  fileExtension,
  inferMonacoLanguageId,
  isMonacoLanguageId,
} from "./language-inference.js";

describe("MONACO_LANGUAGE_IDS", () => {
  it("covers every language id required by Issue #1193 acceptance criteria", () => {
    // AC: TypeScript, TSX, JavaScript, JSX, JSON, CSS, HTML, Markdown, YAML, Python, Java, Go,
    // Rust, SQL, shell, and plain-text fallback. TSX/JSX fold onto typescript/javascript ids.
    expect([...MONACO_LANGUAGE_IDS]).toEqual([
      "typescript",
      "javascript",
      "json",
      "css",
      "html",
      "markdown",
      "yaml",
      "python",
      "java",
      "go",
      "rust",
      "sql",
      "shell",
      "plaintext",
    ]);
  });

  it("includes the plaintext fallback id", () => {
    expect(MONACO_LANGUAGE_IDS).toContain(MONACO_PLAINTEXT_LANGUAGE_ID);
    expect(MONACO_PLAINTEXT_LANGUAGE_ID).toBe("plaintext");
  });

  it("only maps extensions onto known language ids", () => {
    for (const id of Object.values(MONACO_LANGUAGE_BY_EXTENSION)) {
      expect(MONACO_LANGUAGE_IDS).toContain(id);
    }
  });
});

describe("fileExtension", () => {
  it("returns the lower-cased extension without the dot", () => {
    expect(fileExtension("Component.TSX")).toBe("tsx");
    expect(fileExtension("service.ts")).toBe("ts");
  });

  it("uses only the final path segment, for POSIX and Windows paths", () => {
    expect(fileExtension("src/app/main.py")).toBe("py");
    expect(fileExtension("C:\\repo\\build.go")).toBe("go");
  });

  it("uses the last dot in multi-dotted names", () => {
    expect(fileExtension("widget.test.ts")).toBe("ts");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("treats dotfiles, extension-less names, trailing dots, and empty input as no extension", () => {
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("notes.")).toBe("");
    expect(fileExtension("")).toBe("");
  });
});

describe("inferMonacoLanguageId", () => {
  it("maps each first-class source extension to its Monaco language id", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["index.ts", "typescript"],
      ["index.mts", "typescript"],
      ["index.cts", "typescript"],
      ["App.tsx", "typescript"],
      ["index.js", "javascript"],
      ["index.mjs", "javascript"],
      ["index.cjs", "javascript"],
      ["App.jsx", "javascript"],
      ["package.json", "json"],
      ["tsconfig.jsonc", "json"],
      ["styles.css", "css"],
      ["page.html", "html"],
      ["page.htm", "html"],
      ["README.md", "markdown"],
      ["CHANGELOG.markdown", "markdown"],
      ["ci.yaml", "yaml"],
      ["ci.yml", "yaml"],
      ["train.py", "python"],
      ["types.pyi", "python"],
      ["Main.java", "java"],
      ["server.go", "go"],
      ["lib.rs", "rust"],
      ["query.sql", "sql"],
      ["deploy.sh", "shell"],
      ["setup.bash", "shell"],
      ["profile.zsh", "shell"],
    ];
    for (const [name, expected] of cases) {
      expect(inferMonacoLanguageId(name)).toBe(expected);
    }
  });

  it("folds TSX onto typescript and JSX onto javascript (monaco has no distinct tsx/jsx id)", () => {
    expect(inferMonacoLanguageId("View.tsx")).toBe("typescript");
    expect(inferMonacoLanguageId("View.jsx")).toBe("javascript");
  });

  it("is case-insensitive on the extension", () => {
    expect(inferMonacoLanguageId("Service.TS")).toBe("typescript");
    expect(inferMonacoLanguageId("DATA.JSON")).toBe("json");
  });

  it("resolves the language id from a full path", () => {
    expect(inferMonacoLanguageId("packages/keiko-editor/src/monaco/theme.ts")).toBe("typescript");
  });

  it("falls back to plaintext for unknown extensions, dotfiles, and extension-less names", () => {
    expect(inferMonacoLanguageId("archive.bin")).toBe("plaintext");
    expect(inferMonacoLanguageId(".gitignore")).toBe("plaintext");
    expect(inferMonacoLanguageId("LICENSE")).toBe("plaintext");
    expect(inferMonacoLanguageId("")).toBe("plaintext");
  });
});

describe("isMonacoLanguageId", () => {
  it("accepts recognised ids and rejects everything else", () => {
    expect(isMonacoLanguageId("typescript")).toBe(true);
    expect(isMonacoLanguageId("plaintext")).toBe(true);
    expect(isMonacoLanguageId("tsx")).toBe(false);
    expect(isMonacoLanguageId("cobol")).toBe(false);
    expect(isMonacoLanguageId("")).toBe(false);
  });
});

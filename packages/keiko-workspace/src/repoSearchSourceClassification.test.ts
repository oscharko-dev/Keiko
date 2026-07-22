import { describe, expect, it } from "vitest";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";

describe("repositorySourceLines", () => {
  it("separates TypeScript code from comments, quoted examples, and regex literals", () => {
    const lines = repositorySourceLines(
      [
        'const documentation = "function fakeHandler() {}";',
        "const matcher = /https?:\\/\\/fakeHandler/;",
        'router.get("/real", realHandler);',
        '// router.get("/commented", fakeHandler);',
        "/* function blockCommentHandler() {}",
        " * still commented */ const actual = true;",
      ].join("\n"),
      "src/routes.ts",
    );

    expect(lines[0]?.code).toContain("function fakeHandler");
    expect(lines[0]?.structural).not.toContain("fakeHandler");
    expect(lines[1]?.code).not.toContain("fakeHandler");
    expect(lines[2]?.code).toContain('"/real"');
    expect(lines[2]?.structural).toContain("router.get(");
    expect(lines[2]?.structural).not.toContain("/real");
    expect(lines[3]?.code.trim()).toBe("");
    expect(lines[4]?.structural.trim()).toBe("");
    expect(lines[5]?.structural).toContain("const actual = true;");
  });

  it("preserves UTF-16 offsets while masking comments after astral identifiers", () => {
    const raw = `${"𝐀".repeat(23)} // function fakeHandler() {}`;
    const line = repositorySourceLines(raw, "src/astral.ts")[0];

    expect(line?.code).toHaveLength(raw.length);
    expect(line?.structural).toHaveLength(raw.length);
    expect(line?.code).not.toContain("fakeHandler");
    expect(line?.structural).not.toContain("fakeHandler");
  });

  it("masks Python comments and docstrings without hiding real definitions and decorators", () => {
    const lines = repositorySourceLines(
      [
        '"""def documented_handler():',
        '    documented text"""',
        "# def commented_handler(): pass",
        'def real_handler(): return "ok"',
        '@router.get("/real")',
      ].join("\n"),
      "src/routes.py",
    );

    expect(lines[0]?.code).toContain("documented_handler");
    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural.trim()).toBe("");
    expect(lines[2]?.structural.trim()).toBe("");
    expect(lines[3]?.structural).toContain("def real_handler(): return");
    expect(lines[3]?.structural).not.toContain("ok");
    expect(lines[4]?.code).toContain("/real");
    expect(lines[4]?.structural).toContain("@router.get(");
  });

  it("treats Python hash-bracket text as a comment rather than a Rust-style attribute", () => {
    const lines = repositorySourceLines(
      "#[ def fake_handler(): pass\ndef real_handler(): pass",
      "src/handlers.py",
    );

    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural).toContain("def real_handler");
  });

  it("uses language-specific multiline and line comments", () => {
    const lua = repositorySourceLines(
      "--[[ function fake() end\nstill fake ]] function real() end\nlocal half = total // 2",
      "src/routes.lua",
    );
    const ruby = repositorySourceLines(
      "=begin\ndef fake_handler; end\n=end\ndef real_handler; end",
      "src/routes.rb",
    );
    const visualBasic = repositorySourceLines(
      "REM Sub FakeHandler()\nPublic Sub RealHandler()",
      "src/Routes.vb",
    );
    const razor = repositorySourceLines(
      "@* void FakeHandler() {} *@\n@functions { void RealHandler() {} }",
      "src/Routes.razor",
    );

    expect(lua[0]?.structural.trim()).toBe("");
    expect(lua[1]?.structural).toContain("function real");
    expect(lua[2]?.structural).toContain("total // 2");
    expect(ruby.slice(0, 3).every((line) => line.structural.trim() === "")).toBe(true);
    expect(ruby[3]?.structural).toContain("def real_handler");
    expect(visualBasic[0]?.structural.trim()).toBe("");
    expect(visualBasic[1]?.structural).toContain("Sub RealHandler");
    expect(razor[0]?.structural.trim()).toBe("");
    expect(razor[1]?.structural).toContain("void RealHandler");
  });

  it("supports leveled Lua long comments", () => {
    const lines = repositorySourceLines(
      "--[=[ function fake_handler() end\nstill fake ]=] function real_handler() end",
      "src/routes.lua",
    );

    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural).not.toContain("still fake");
    expect(lines[1]?.structural).toContain("function real_handler");
  });

  it.each([
    {
      content:
        'var docs = @"documentation\npublic void FakeHandler() {}\n";\npublic void RealHandler() {}',
      scopePath: "src/Routes.cs",
    },
    {
      content: 'let docs = """\nlet fakeHandler() = ()\n"""\nlet realHandler() = ()',
      scopePath: "src/routes.fs",
    },
    {
      content: "def docs = '''\ndef fakeHandler() {}\n'''\ndef realHandler() {}",
      scopePath: "src/Routes.groovy",
    },
    {
      content: "local docs = [=[\nfunction fakeHandler() end\n]=]\nfunction realHandler() end",
      scopePath: "src/routes.lua",
    },
    {
      content: "documentation: |-\n  function fakeHandler() {}\nrealHandler: enabled",
      scopePath: "config/routes.yaml",
    },
    {
      content: "cat <<'DOC'\nfunction fakeHandler() {}\nDOC\nfunction realHandler() { :; }",
      scopePath: "scripts/routes.sh",
    },
    {
      content:
        "<?php\n$docs = <<<'DOC'\nfunction fakeHandler() {}\nDOC;\nfunction realHandler() {}",
      scopePath: "src/routes.php",
    },
    {
      content:
        '<?php\n$docs = <<<"DOC"\nfunction fakeHandler() {}\nDOC;\nfunction realHandler() {}',
      scopePath: "src/routes.php",
    },
  ])(
    "masks definitions inside multiline literal regions for $scopePath",
    ({ content, scopePath }) => {
      const lines = repositorySourceLines(content, scopePath);
      const code = lines
        .map((line) => line.code)
        .join("\n")
        .toLowerCase();
      const structural = lines
        .map((line) => line.structural)
        .join("\n")
        .toLowerCase();

      expect(code).toContain("fakehandler");
      expect(structural).not.toContain("fakehandler");
      expect(structural).toContain("realhandler");
    },
  );

  it("masks SQL block comments without hiding following statements", () => {
    const lines = repositorySourceLines(
      "/* function fakeHandler() {} */\nCREATE FUNCTION realHandler() RETURNS void;",
      "schema/routes.sql",
    );

    expect(lines[0]?.code.trim()).toBe("");
    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural).toContain("FUNCTION realHandler");
  });

  it("tracks multiple shell heredocs without accepting a PHP-style terminator", () => {
    const lines = repositorySourceLines(
      [
        "cat <<FIRST <<'SECOND'",
        "function fakeFirst() {}",
        "FIRST;",
        "function stillFakeFirst() {}",
        "FIRST",
        "function fakeSecond() {}",
        "SECOND",
        "function realHandler() { :; }",
      ].join("\n"),
      "scripts/heredocs.sh",
    );
    const structural = lines.map((line) => line.structural).join("\n");

    expect(structural).not.toContain("fakeFirst");
    expect(structural).not.toContain("stillFakeFirst");
    expect(structural).not.toContain("fakeSecond");
    expect(structural).toContain("realHandler");
  });

  it("supports indented PHP terminators and explicit YAML scalar indentation", () => {
    const php = repositorySourceLines(
      "$docs = <<<DOC\nfunction fakeHandler() {}\n  DOC;   \nfunction realHandler() {}",
      "src/routes.php",
    );
    const yaml = repositorySourceLines(
      "outer:\n  docs: >2-\n    function fakeHandler() {}\n  realHandler: enabled",
      "config/routes.yml",
    );

    expect(php[1]?.structural.trim()).toBe("");
    expect(php[3]?.structural).toContain("realHandler");
    expect(yaml[2]?.structural.trim()).toBe("");
    expect(yaml[3]?.structural).toContain("realHandler");
  });

  it("keeps JavaScript template expressions structural while masking template text", () => {
    const line = repositorySourceLines(
      "const rendered = `function fakeText() {} ${function realExpression() { return `nested fake ${realNested()}`; }} tail fake`;",
      "src/template.ts",
    )[0];

    expect(line?.structural).not.toContain("fakeText");
    expect(line?.structural).not.toContain("tail fake");
    expect(line?.structural).not.toContain("nested fake");
    expect(line?.structural).toContain("function realExpression");
    expect(line?.structural).toContain("realNested()");
  });

  it("tracks multiline JavaScript template expressions through nested braces", () => {
    const lines = repositorySourceLines(
      [
        "const rendered = `fake text \\${escapedHandler()}",
        "${({ realHandler: () => ({ nested: true }) }).realHandler()}",
        "fake tail`;",
        "function afterTemplate() {}",
      ].join("\n"),
      "src/template.ts",
    );
    const structural = lines.map((line) => line.structural).join("\n");

    expect(structural).not.toContain("escapedHandler");
    expect(structural).not.toContain("fake text");
    expect(structural).not.toContain("fake tail");
    expect(structural).toContain("realHandler");
    expect(structural).toContain("afterTemplate");
  });

  it.each([
    ['auto example = R"tag(function fakeHandler() {})tag";\nvoid realHandler() {}', "src/a.cpp"],
    ['var example = """function fakeHandler() {}""";\nvoid realHandler() {}', "src/A.cs"],
    ['var example = """"function fakeHandler() {}"""";\nvoid realHandler() {}', "src/A.cs"],
    ['val example = """fun fakeHandler() {}"""\nfun realHandler() {}', "src/A.kt"],
    ['let example = r#"fn fake_handler() {}"#;\nfn real_handler() {}', "src/a.rs"],
  ])("masks definitions inside raw strings for %s", (content, scopePath) => {
    const lines = repositorySourceLines(content, scopePath);

    expect(lines[0]?.structural).not.toMatch(/fake[_A-Z]/iu);
    expect(lines[1]?.structural).toMatch(/real[_A-Z]/iu);
  });

  it.each([
    ['var example = """text\\""";\npublic void RealHandler() {}', "src/A.cs"],
    ['val example = """text\\"""\nfun realHandler() {}', "src/A.kt"],
    ['let example = """text\\"""\nfunc realHandler() {}', "src/A.swift"],
  ])("does not escape a raw triple-string closing delimiter for %s", (content, scopePath) => {
    expect(repositorySourceLines(content, scopePath)[1]?.structural).toMatch(/real[_A-Z]/iu);
  });

  it("keeps fake definitions inside longer C# raw delimiters masked", () => {
    const line = repositorySourceLines(
      'var doc = """"text """ public void FakeHandler() {} """";',
      "src/A.cs",
    )[0];

    expect(line?.structural).not.toContain("FakeHandler");
  });

  it("recognizes Java Unicode-escaped comments", () => {
    const lines = repositorySourceLines(
      "\\u002f\\u002f void fakeHandler() {}\n\\u002f\\u002a void fakeToo() {} \\u002a\\u002f void realHandler() {}",
      "src/Routes.java",
    );

    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural).not.toContain("fakeToo");
    expect(lines[1]?.structural).toContain("void realHandler");
  });

  it.each(["\\u002f/", "/\\u002f", "\\uuuu002f\\u002f"])(
    "recognizes mixed Java Unicode line-comment delimiter %s",
    (delimiter) => {
      const line = repositorySourceLines(
        `${delimiter} public void FakeHandler() {}`,
        "src/Routes.java",
      )[0];

      expect(line?.structural.trim()).toBe("");
    },
  );

  it("does not mistake line-leading JavaScript division for a regular expression", () => {
    const line = repositorySourceLines("/ 2; function realHandler() {}", "src/math.js")[0];

    expect(line?.code).toContain("function realHandler");
    expect(line?.structural).toContain("function realHandler");
  });

  it("bounds failed JavaScript regular-expression closure scans", () => {
    const line = repositorySourceLines(
      `${"/[".repeat(20_000)}; function realHandler() {}`,
      "src/adversarial.js",
    )[0];

    expect(line?.structural).toContain("function realHandler");
  });

  it("keeps assigned triple-quoted route values only in the code view", () => {
    const line = repositorySourceLines('path = """/orders/{id}"""', "src/routes.py")[0];

    expect(line?.code).toContain("/orders/{id}");
    expect(line?.structural).not.toContain("/orders/{id}");
  });

  it("keeps indented triple-quoted route arguments in the code view", () => {
    const lines = repositorySourceLines('@app.get(\n    """/health"""\n)', "src/routes.py");

    expect(lines[1]?.code).toContain("/health");
    expect(lines[1]?.structural).not.toContain("/health");
  });

  it.each([
    ["// go 1.20\ngo 1.24", "go.mod"],
    ["# nodejs 18.0\nnodejs 24.0", ".tool-versions"],
  ])("uses the correct comment profile for %s", (content, scopePath) => {
    const lines = repositorySourceLines(content, scopePath);

    expect(lines[0]?.structural.trim()).toBe("");
    expect(lines[1]?.structural.trim()).not.toBe("");
  });

  it("handles nested Rust comments while preserving route attributes", () => {
    const lines = repositorySourceLines(
      [
        "/* outer",
        "/* fn nested_fake() {} */",
        "fn outer_fake() {} */",
        '#[get("/orders/{id}")] async fn get_order() {}',
      ].join("\n"),
      "src/routes.rs",
    );

    expect(lines.slice(0, 3).every((line) => line.structural.trim().length === 0)).toBe(true);
    expect(lines[3]?.code).toContain("/orders/{id}");
    expect(lines[3]?.structural).toContain("#[get(");
    expect(lines[3]?.structural).toContain("async fn get_order");
  });

  it("does not classify fenced documentation as executable source", () => {
    const lines = repositorySourceLines(
      '```ts\nrouter.get("/example", exampleHandler);\n```',
      "docs/routes.md",
    );

    expect(lines.every((line) => line.code.trim().length === 0)).toBe(true);
    expect(lines.every((line) => line.structural.trim().length === 0)).toBe(true);
    expect(
      repositorySourceLines("function documentedOnly() {}", "README")[0]?.structural.trim(),
    ).toBe("");
  });

  it.each(["NOTICE", "AUTHORS", "docs/architecture", "docs/unknown.prose"])(
    "fails closed for unrecognized documentation path %s",
    (scopePath) => {
      const line = repositorySourceLines(
        'function documentedOnly() {} router.get("/example", handler);',
        scopePath,
      )[0];

      expect(line?.code.trim()).toBe("");
      expect(line?.structural.trim()).toBe("");
    },
  );

  it.each(["Dockerfile", "Makefile", "CMakeLists.txt", "BUILD.bazel", "Gemfile"])(
    "uses hash comments for recognized extensionless source %s",
    (scopePath) => {
      const lines = repositorySourceLines(
        '# router.get("/commented", fake_handler)\nreal_target: build',
        scopePath,
      );

      expect(lines[0]?.structural.trim()).toBe("");
      expect(lines[1]?.structural).toContain("real_target");
    },
  );
});

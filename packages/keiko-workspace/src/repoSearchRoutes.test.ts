import { describe, expect, it } from "vitest";
import {
  repositoryRouteDeclarationMarker,
  repositoryRouteDeclarationMarkers,
  repositoryRouteQuery,
} from "./repoSearchRoutes.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";

function markers(content: string, scopePath: string): readonly string[] {
  const lines = repositorySourceLines(content, scopePath);
  return repositoryRouteDeclarationMarkers(
    lines.map((line) => line.code).join("\n"),
    lines.map((line) => line.structural).join("\n"),
  );
}

function marker(method: string, path: string): string {
  return repositoryRouteDeclarationMarker(method, path);
}

describe("repositoryRouteDeclarationMarkers", () => {
  it("recognizes a root route without classifying an arithmetic slash as a route path", () => {
    expect(repositoryRouteQuery("Where is GET / defined?")).toEqual({ method: "get", path: "/" });
    expect(markers('router.get("/", rootHandler);', "src/routes.ts")).toEqual([marker("get", "/")]);
    expect(markers("app.get(primaryHandler / fallbackHandler);", "src/routes.ts")).toEqual([]);
    expect(
      repositoryRouteQuery("How does GET primaryHandler / fallbackHandler work?"),
    ).toBeUndefined();
  });

  it.each([
    ['{ method: "GET", path: "/", handler: root }', "config/routes.json"],
    ["routes:\n  - method: GET\n    path: /\n    handler: root", "config/routes.yaml"],
    ['@RequestMapping(path = "/", method = RequestMethod.GET)', "src/Routes.java"],
    ['[HttpGet("/")] public IActionResult Root() {', "src/Routes.cs"],
    ['get "/", to: "home#index"', "config/routes.rb"],
  ])("binds an explicitly declared root route: %s", (content, scopePath) => {
    expect(markers(content, scopePath)).toContain(marker("get", "/"));
  });

  it("keeps adjacent declarations bound instead of producing a method-path cross product", () => {
    const found = markers('router.get("/a", getA);\nrouter.post("/b", postB);', "src/routes.ts");

    expect(found).toEqual([marker("get", "/a"), marker("post", "/b")]);
    expect(found).not.toContain(marker("post", "/a"));
    expect(found).not.toContain(marker("get", "/b"));
  });

  it("extracts method-first, path-first, and quoted configured routes independently", () => {
    const found = markers(
      [
        "[{ method: 'GET', path: '/a', handler: getA },",
        " { path: '/b', handler: postB, method: 'POST' },",
        ' { "handler": "putC", "path": "/c", "method": "PUT" }]',
      ].join("\n"),
      "config/routes.json",
    );

    expect(new Set(found)).toEqual(
      new Set([marker("get", "/a"), marker("post", "/b"), marker("put", "/c")]),
    );
    expect(found).not.toContain(marker("post", "/a"));
  });

  it("does not combine nested configured records or quoted handler labels", () => {
    const configured = markers(
      '{ a: { method: "GET", handler: getA }, b: { path: "/b", method: "POST", handler: postB } }',
      "src/routes.ts",
    );
    const fluent = markers(
      [
        '.route("/a", get(handler.with_label("POST")))',
        'r.HandleFunc("/b", handler("POST")).Methods("GET")',
        '@app.route("/c", endpoint=handler("POST"))',
      ].join("\n"),
      "src/routes.py",
    );

    expect(configured).toEqual([marker("post", "/b")]);
    expect(fluent).toEqual([marker("get", "/a"), marker("get", "/b")]);
  });

  it("recognizes a bounded unquoted YAML route record", () => {
    const found = markers("{ method: GET, path: /health, handler: health }", "config/routes.yaml");

    expect(found).toEqual([marker("get", "/health")]);
  });

  it("binds fields within ordinary YAML block route mappings", () => {
    const found = markers(
      [
        "routes:",
        "  - method: GET",
        "    path: /health",
        "    handler: health",
        "  - path: /orders/{id}",
        "    handler: updateOrder",
        "    method: PATCH",
      ].join("\n"),
      "config/routes.yaml",
    );

    expect(found).toEqual([marker("get", "/health"), marker("patch", "/orders/{id}")]);
    expect(found).not.toContain(marker("patch", "/health"));
    expect(found).not.toContain(marker("get", "/orders/{id}"));
  });

  it("supports an empty YAML sequence indicator without flattening nested metadata", () => {
    const direct = markers(
      "routes:\n  -\n    method: POST\n    path: /health\n    handler: health",
      "config/routes.yaml",
    );
    const nested = markers(
      "items:\n  - metadata:\n      method: GET\n      path: /fake\n      handler: fake",
      "config/routes.yaml",
    );

    expect(direct).toEqual([marker("post", "/health")]);
    expect(nested).toEqual([]);
  });

  it("does not merge YAML route fields beyond the declaration window", () => {
    const found = markers(
      [
        "routes:",
        "  - method: GET",
        "    name: delayed",
        "    metadata: value",
        "    path: /too-late",
        "    handler: delayed",
      ].join("\n"),
      "config/routes.yaml",
    );

    expect(found).toEqual([]);
  });

  it("recognizes an indented triple-quoted Python route argument", () => {
    const found = markers('@app.get(\n    """/health"""\n)\ndef health(): pass', "src/routes.py");

    expect(found).toContain(marker("get", "/health"));
  });

  it.each([
    ['var docs = @"router.get(""/fake"", fake);\ncontinued";', "src/Routes.cs"],
    ['let docs = """\nrouter.get("/fake", fake)\n"""', "src/routes.fs"],
    ["def docs = '''\nrouter.get('/fake', fake)\n'''", "src/Routes.groovy"],
    ["local docs = [=[\nrouter.get('/fake', fake)\n]=]", "src/routes.lua"],
    ["documentation: |-\n  router.get('/fake', fake)", "config/routes.yaml"],
    ["cat <<'DOC'\nrouter.get('/fake', fake)\nDOC", "scripts/routes.sh"],
    ["<?php\n$docs = <<<'DOC'\nRoute::get('/fake', Fake::class);\nDOC;", "src/routes.php"],
    ["/* router.get('/fake', fake); */", "schema/routes.sql"],
  ])("does not extract a route from a multiline non-code region: %s", (content, scopePath) => {
    expect(markers(content, scopePath)).not.toContain(marker("get", "/fake"));
  });

  it("extracts routes from template expressions but not template text", () => {
    const found = markers(
      'const rendered = `router.get("/fake", fake); ${router.post("/real", real)}`;',
      "src/routes.ts",
    );

    expect(found).toEqual([marker("post", "/real")]);
  });

  it.each([
    ['@app.route("/a", methods=["GET", "POST"])', "src/routes.py"],
    ['r.HandleFunc("/a", handler).Methods("GET", "POST")', "src/routes.go"],
    ['r.HandleFunc("/a", handler).Methods(http.MethodGet, http.MethodPost)', "src/routes.go"],
  ])("retains every explicitly bound method: %s", (content, scopePath) => {
    expect(new Set(markers(content, scopePath))).toEqual(
      new Set([marker("get", "/a"), marker("post", "/a")]),
    );
  });

  it.each([
    ['r.HandleFunc("/orders/{id}", getOrder).Methods("GET")', "src/routes.go", "GET"],
    [
      'r.HandleFunc("/orders/{id}", updateOrder).Methods(http.MethodPatch)',
      "src/routes.go",
      "PATCH",
    ],
    ['@GET\n@Path("/orders/{id}")\npublic Order getOrder() {', "src/Routes.java", "GET"],
    ['@Path("/orders/{id}")\n@GET\npublic Order getOrder() {', "src/Routes.java", "GET"],
    [
      '@Path("/orders/{id}")\n@Produces("application/json")\n@GET\npublic Order getOrder() {',
      "src/Routes.java",
      "GET",
    ],
    ['get("/orders/{id}") { call.respond(getOrder()) }', "src/Routes.kt", "GET"],
    ['r.Get("/orders/{id}", getOrder)', "src/routes.go", "GET"],
    ['[HttpGet("/orders/{id}")] public IActionResult GetOrder() {', "src/Routes.cs", "GET"],
    ['@GetMapping("/orders/{id}") public Order getOrder() {', "src/Routes.java", "GET"],
    ['#[get("/orders/{id}")] async fn get_order() {', "src/routes.rs", "GET"],
    ['@router.get("/orders/{id}")\ndef get_order():', "src/routes.py", "GET"],
    ['Route::get("/orders/{id}", GetOrder::class);', "src/routes.php", "GET"],
  ])("recognizes a bound polyglot route declaration: %s", (content, scopePath, method) => {
    expect(markers(content, scopePath)).toContain(marker(method, "/orders/{id}"));
  });

  it("binds Spring RequestMapping path/value attributes to their explicit methods", () => {
    const found = markers(
      [
        '@RequestMapping(path = "/orders/{id}", method = RequestMethod.GET)',
        "public Order getOrder() {",
        '@RequestMapping(value = "/orders", method = RequestMethod.POST)',
        "public Order createOrder() {",
      ].join("\n"),
      "src/OrdersController.java",
    );

    expect(found).toEqual([marker("get", "/orders/{id}"), marker("post", "/orders")]);
    expect(found).not.toContain(marker("post", "/orders/{id}"));
    expect(found).not.toContain(marker("get", "/orders"));
  });

  it("binds adjacent ASP.NET Route and HTTP method attributes without a cross product", () => {
    const found = markers(
      [
        '[Route("/orders/{id}")]',
        "[HttpGet]",
        "public IActionResult GetOrder() {",
        '[Route("/orders")]',
        "[HttpPost]",
        "public IActionResult CreateOrder() {",
      ].join("\n"),
      "src/OrdersController.cs",
    );

    expect(found).toEqual([marker("get", "/orders/{id}"), marker("post", "/orders")]);
    expect(found).not.toContain(marker("post", "/orders/{id}"));
    expect(found).not.toContain(marker("get", "/orders"));
  });

  it("binds adjacent Rails verb routes to their own paths", () => {
    const found = markers(
      ['get "/orders/:id", to: "orders#show"', 'post "/orders", to: "orders#create"'].join("\n"),
      "config/routes.rb",
    );

    expect(found).toEqual([marker("get", "/orders/:id"), marker("post", "/orders")]);
    expect(found).not.toContain(marker("post", "/orders/:id"));
    expect(found).not.toContain(marker("get", "/orders"));
  });

  it.each([
    [
      [
        "@RequestMapping(method = RequestMethod.GET)",
        'public String index() { return "/not-a-route"; }',
        '@RequestMapping(path = "/orders", method = RequestMethod.POST)',
      ].join("\n"),
      "src/OrdersController.java",
    ],
    [
      [
        "[HttpGet]",
        'public IActionResult Index() { return Content("/not-a-route"); }',
        '[Route("/orders")]',
        "[HttpPost]",
      ].join("\n"),
      "src/OrdersController.cs",
    ],
    [['get "/not-a-route"', 'post "/orders", to: "orders#create"'].join("\n"), "config/routes.rb"],
  ])(
    "does not borrow a path or method from the next adjacent declaration: %s",
    (content, scopePath) => {
      expect(markers(content, scopePath)).toEqual([marker("post", "/orders")]);
    },
  );

  it.each([
    [
      [
        "@RequestMapping(",
        '  path = "/too-far",',
        '  name = "orders",',
        '  headers = "x-test=true",',
        "  method = RequestMethod.GET)",
      ].join("\n"),
      "src/OrdersController.java",
    ],
    [
      [
        '[Route("/too-far")]',
        "[Authorize]",
        "[ProducesResponseType(200)]",
        '[Consumes("application/json")]',
        "[HttpGet]",
      ].join("\n"),
      "src/OrdersController.cs",
    ],
    [
      [
        'get "/too-far",',
        "  defaults: { format: :json },",
        "  constraints: ApiConstraint,",
        "  anchor: true,",
        '  to: "orders#show"',
      ].join("\n"),
      "config/routes.rb",
    ],
  ])("does not merge a route declaration beyond the bounded window: %s", (content, scopePath) => {
    expect(markers(content, scopePath)).toEqual([]);
  });

  it.each([
    ['@RequestMapping(path = "/missing-method")', "src/OrdersController.java"],
    ["@RequestMapping(method = RequestMethod.GET)", "src/OrdersController.java"],
    [
      '@RequestMapping(method = RequestMethod.GET)\nString index() { return "/body"; }',
      "src/OrdersController.java",
    ],
    ['[Route("/missing-method")]\npublic IActionResult Index() {', "src/OrdersController.cs"],
    ["[HttpGet]\npublic IActionResult Index() {", "src/OrdersController.cs"],
    [
      '[HttpGet]\npublic IActionResult Index() { return Content("/body"); }',
      "src/OrdersController.cs",
    ],
    ['get "/missing-target"', "config/routes.rb"],
    ['get "/missing-target",\nsettings = { to: handler }', "config/routes.rb"],
    ['to: "orders#show"', "config/routes.rb"],
  ])("fails closed for an incomplete framework route: %s", (content, scopePath) => {
    expect(markers(content, scopePath)).toEqual([]);
  });
});

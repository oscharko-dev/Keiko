import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";

import {
  buildMatcher,
  fingerprintFor,
  lineLooksLikeSymbolDefinition,
  normalizeNaturalLanguageToken,
} from "./repoSearchMatchers.js";

describe("trusted literal query interpretation", () => {
  it("matches spaces and punctuation literally without regex expansion", () => {
    const query = { ...nlq("( ".repeat(100)), kind: "exact-symbol" as const };
    expect(buildMatcher(query, { kind: "literal" }).match(query.text)).toBe(1);
    expect(() => buildMatcher(query)).toThrow("whitespace");
    expect(fingerprintFor(query, { kind: "literal" })).not.toBe(fingerprintFor(query));
  });
  it("cannot turn the regex lane into a bypass of its canonical safety gate", () => {
    const query = { ...nlq("(a+)+"), kind: "regex" as const };
    expect(() => buildMatcher(query)).toThrow("unsafe");
    expect(() => buildMatcher(query, { kind: "literal" })).toThrow("exact-text");
    expect(() => buildMatcher({ ...query, text: "x".repeat(201) })).toThrow("too long");
  });
});

function nlq(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

describe("normalizeNaturalLanguageToken", () => {
  it("strips leading/trailing punctuation while preserving internal punctuation", () => {
    expect(normalizeNaturalLanguageToken("ADR-0022")).toBe("ADR-0022");
    expect(normalizeNaturalLanguageToken("-ADR-0022-")).toBe("ADR-0022");
    expect(normalizeNaturalLanguageToken("file.ts")).toBe("file.ts");
    expect(normalizeNaturalLanguageToken(".file.ts.")).toBe("file.ts");
    expect(normalizeNaturalLanguageToken("!!!hello???")).toBe("hello");
    expect(normalizeNaturalLanguageToken("")).toBe("");
    expect(normalizeNaturalLanguageToken("???")).toBe("");
    expect(normalizeNaturalLanguageToken("héllo")).toBe("héllo");
  });

  // SonarCloud S8786: the trailing strip used to be the unanchored `[^\p{L}\p{N}]+$`. Without a
  // `^` anchor, the engine retries the match at every position inside a long non-alphanumeric run
  // before concluding there is no match at the string's end — quadratic in input length. Keep the
  // adversarial shape as a functional regression fixture; static analysis owns the performance
  // detection without a host-load-sensitive timer.
  //
  // The adversarial input MUST start with an alphanumeric character. A run of non-alnum
  // characters at the very START of the string (e.g. `"!".repeat(60_000) + "a"`) is fully
  // consumed by the (always-safe, `^`-anchored) leading strip before the previously-vulnerable
  // trailing strip ever sees more than a 1-character string — that shape exercises no quadratic
  // behavior at all, on either the old or the new implementation. Anchoring the run between two
  // alphanumeric characters (`"x" + "!"*60_000 + "a"`) means the leading strip matches nothing
  // (the string already starts with an alnum char), so the full 60,000-character run reaches the
  // trailing-strip logic — this is what actually reproduces the O(n^2) blowup on the old
  // `[^\p{L}\p{N}]+$` pattern (~1.8s at 60k characters on the pre-fix code).
  it("handles a long embedded non-alphanumeric run bounded by alnum chars (regression for SonarCloud S8786)", () => {
    const adversarial = `x${"!".repeat(60_000)}a`;
    const result = normalizeNaturalLanguageToken(adversarial);
    // Internal punctuation between two alphanumeric characters is preserved (same contract as the
    // "ADR-0022" case above) — the string is unchanged because there is nothing to strip at
    // either end.
    expect(result).toBe(adversarial);
  });
});

describe("buildMatcher definition intent scoring", () => {
  it("matches typed declarations without unbounded whitespace backtracking", () => {
    expect(
      lineLooksLikeSymbolDefinition(
        "public Task<Result<User>> loadUser(UserId id) {",
        "loadUser",
        false,
      ),
    ).toBe(true);
    const adversarial = `T${" ".repeat(40_000)}missing`;
    expect(lineLooksLikeSymbolDefinition(adversarial, "loadUser", false)).toBe(false);
    expect(lineLooksLikeSymbolDefinition("Return loadUser() {", "loadUser", false)).toBe(true);
  });

  it("does not classify JavaScript unary-expression calls as typed declarations", () => {
    for (const prefix of ["void", "typeof", "delete"]) {
      expect(lineLooksLikeSymbolDefinition(`${prefix} loadUser()`, "loadUser", false)).toBe(false);
    }
    expect(
      lineLooksLikeSymbolDefinition("public Task<User> loadUser(UserId id) {", "loadUser", false),
    ).toBe(true);
  });

  it.each([
    "value instanceof loadUser()",
    '"loadUser" in loadUser()',
    "for (const value of loadUser()) {}",
    "else loadUser()",
    "do loadUser()",
    "case loadUser():",
    "default loadUser()",
    "with loadUser()",
    "assert loadUser()",
    "raise loadUser()",
  ])("does not classify control-flow calls as typed declarations: %s", (line) => {
    expect(lineLooksLikeSymbolDefinition(line, "loadUser", false)).toBe(false);
  });

  it("recognizes implemented JVM and .NET void methods without admitting unary calls", () => {
    expect(
      lineLooksLikeSymbolDefinition(
        "void handleRequest(Request request) {",
        "handleRequest",
        false,
      ),
    ).toBe(true);
    expect(
      lineLooksLikeSymbolDefinition(
        "public void handleRequest(Request request) {",
        "handleRequest",
        false,
      ),
    ).toBe(true);
    expect(
      lineLooksLikeSymbolDefinition(
        "internal async void HandleRequest(Request request) => await dispatch(request);",
        "HandleRequest",
        false,
      ),
    ).toBe(true);
    expect(
      lineLooksLikeSymbolDefinition(
        "public abstract void handleRequest(Request request);",
        "handleRequest",
        false,
      ),
    ).toBe(true);
    expect(lineLooksLikeSymbolDefinition("void handleRequest()", "handleRequest", false)).toBe(
      false,
    );
  });

  it("does not classify Go goroutine or deferred calls as declarations", () => {
    expect(lineLooksLikeSymbolDefinition("go handler()", "handler", false)).toBe(false);
    expect(lineLooksLikeSymbolDefinition("defer handler()", "handler", false)).toBe(false);
  });

  it.each([
    "// function loadUser() {}",
    "# function loadUser() {}",
    "/* function loadUser() {} */",
    'const documentation = "function loadUser() {}";',
  ])("does not classify commented or quoted examples as definitions: %s", (line) => {
    expect(lineLooksLikeSymbolDefinition(line, "loadUser", false)).toBe(false);
  });

  it("recognizes Go receiver methods and JavaScript shorthand methods as definitions", () => {
    expect(
      lineLooksLikeSymbolDefinition(
        "func (service *PaymentService) authorize(payment Payment) error {",
        "authorize",
        false,
      ),
    ).toBe(true);
    expect(lineLooksLikeSymbolDefinition("async authorize(payment) {", "authorize", false)).toBe(
      true,
    );
    expect(
      lineLooksLikeSymbolDefinition(
        "authorize(payment: Payment): Promise<Result> {",
        "authorize",
        false,
      ),
    ).toBe(true);
    expect(
      lineLooksLikeSymbolDefinition(
        "abstract authorize(payment: Payment): Promise<Result>;",
        "authorize",
        false,
      ),
    ).toBe(true);
    expect(
      lineLooksLikeSymbolDefinition(
        "public PaymentService() => initialize();",
        "PaymentService",
        false,
      ),
    ).toBe(true);
  });

  it("boosts lowercase symbol definitions over references", () => {
    const matcher = buildMatcher(nlq("Where is handler defined?"));

    expect(matcher.match("function handler() {")).toBeGreaterThan(
      matcher.match("handler is called by the request router"),
    );
  });

  it("boosts JVM and .NET class declarations over plain references", () => {
    const matcher = buildMatcher(nlq("Where is PaymentService defined?"));
    const reference = matcher.match("PaymentService registry entry");
    expect(matcher.match("public final class PaymentService {")).toBeGreaterThan(reference);
    expect(
      matcher.match("internal sealed partial class PaymentService : BaseService {"),
    ).toBeGreaterThan(reference);
  });

  it("boosts declarations behind the complete supported modifier chain", () => {
    const matcher = buildMatcher(nlq("Where is PaymentService defined?"));
    const reference = matcher.match("PaymentService registry entry");

    expect(
      matcher.match("export default declare readonly static class PaymentService {"),
    ).toBeGreaterThan(reference);
    expect(
      matcher.match("private protected async const PaymentService = create();"),
    ).toBeGreaterThan(reference);
  });

  it("boosts Python, Go, and Rust function/type declarations over plain references", () => {
    const matcher = buildMatcher(nlq("Where is reconcileOrder defined?"));
    const reference = matcher.match("reconcileOrder appears in a comment");
    expect(matcher.match("def reconcileOrder(order):")).toBeGreaterThan(reference);
    expect(matcher.match("func reconcileOrder(order Order) error {")).toBeGreaterThan(reference);
    expect(matcher.match("fn reconcileOrder(order: Order) -> Result<()> {")).toBeGreaterThan(
      reference,
    );
  });

  it("recognizes German definition intent", () => {
    const matcher = buildMatcher(nlq("Wo ist PaymentService definiert?"));
    const reference = matcher.match("PaymentService registry entry");
    expect(matcher.match("export class PaymentService {")).toBeGreaterThan(reference);
  });

  it("ranks English architecture decisions for an equivalent German question", () => {
    const matcher = buildMatcher(
      nlq(
        "Welche drei Autonomie-Modi definiert ADR-0129, und welche zentrale Human-Control-Invariante gilt für Repository-Arbeit?",
      ),
    );
    const modes = matcher.match(
      "Every autonomy-capable surface is governed by the three modes defined in ADR-0129.",
    );
    const adjacentDecision = matcher.match(
      "For repository work targeting dev, accepted task authority permits branch commits.",
    );

    expect(modes).toBeGreaterThan(adjacentDecision);
  });

  it("prefers an exact document reference over another record in the same series", () => {
    const matcher = buildMatcher(nlq("What does ADR-0129 define?"));

    expect(matcher.match("ADR-0129 defines the authority model.")).toBeGreaterThan(
      matcher.match("ADR-0135 defines the delivery model."),
    );
  });

  it("boosts a route declaration for German call-path questions without a definition verb", () => {
    const matcher = buildMatcher(nlq("Prüfe POST /api/chats/messages/grounded: Route zum Handler"));
    const mention = matcher.match("POST /api/chats/messages/grounded route handler documentation");
    const declaration = matcher.match(
      '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },',
    );

    expect(declaration).toBeGreaterThan(mention);
  });

  it.each([
    '[HttpGet("/orders/{order_id}")] public IActionResult GetOrder() {',
    '#[get("/orders/{order_id}")] async fn get_order() {',
    '.route("/orders/{order_id}", get(get_order))',
  ])("boosts polyglot route declaration syntax: %s", (line) => {
    const matcher = buildMatcher(nlq("Trace GET /orders/{order_id} to its handler"));
    const mention = matcher.match("GET /orders/{order_id} is documented for API consumers");

    expect(matcher.match(line)).toBeGreaterThan(mention);
  });
});

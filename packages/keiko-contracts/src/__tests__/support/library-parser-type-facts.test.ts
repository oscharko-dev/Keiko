import { describe, expectTypeOf, it } from "vitest";
import type {
  CheckedResultExpected,
  CheckedResultFacts,
  LibraryParserAcceptedExpected,
  LibraryParserAcceptedFacts,
  LibraryParserTripleIdentityExpected,
  LibraryParserTripleIdentityFacts,
} from "./library-parser-type-facts.js";

type Loose = ReturnType<typeof JSON.parse>;
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };
interface Good {
  readonly id: string;
  readonly nested: { readonly n: number };
}
interface WithLoose {
  readonly id: string;
  readonly loose: Loose;
}
interface WithUnknown {
  readonly id: string;
  readonly loose: unknown;
}
type GoodParser = (input: unknown) => Result<Good>;
type WithLooseParser = (input: unknown) => Result<WithLoose>;
type WithUnknownParser = (input: unknown) => Result<WithUnknown>;
type LooseValueParser = (input: unknown) => Result<Loose>;
type OtherParser = (input: unknown) => Result<{ readonly id: number }>;
type LooseErrorsParser = (
  input: unknown,
) =>
  { readonly ok: true; readonly value: Good } | { readonly ok: false; readonly errors: unknown[] };

// Each negative case must fail to type-check; an unused `@ts-expect-error` fails the build.
describe("library parser type facts", () => {
  it("admits concrete accepted values and refuses any or unknown members", () => {
    expectTypeOf<
      LibraryParserAcceptedFacts<GoodParser, GoodParser, GoodParser, [Good["nested"]["n"]]>
    >().toEqualTypeOf<LibraryParserAcceptedExpected<Result<Good>, Result<Good>, Good>>();
    type AnyMember = LibraryParserAcceptedFacts<
      WithLooseParser,
      WithLooseParser,
      WithLooseParser,
      [WithLoose["loose"]]
    >;
    type AnyMemberExpected = LibraryParserAcceptedExpected<
      Result<WithLoose>,
      Result<WithLoose>,
      WithLoose
    >;
    // @ts-expect-error an `any` member is refused
    expectTypeOf<AnyMember>().toEqualTypeOf<AnyMemberExpected>();
    type UnknownMember = LibraryParserAcceptedFacts<
      WithUnknownParser,
      WithUnknownParser,
      WithUnknownParser,
      [WithUnknown["loose"]]
    >;
    type UnknownMemberExpected = LibraryParserAcceptedExpected<
      Result<WithUnknown>,
      Result<WithUnknown>,
      WithUnknown
    >;
    // @ts-expect-error an `unknown` member is refused
    expectTypeOf<UnknownMember>().toEqualTypeOf<UnknownMemberExpected>();
    type AnyValue = LibraryParserAcceptedFacts<GoodParser, GoodParser, LooseValueParser, []>;
    type AnyValueExpected = LibraryParserAcceptedExpected<Result<Good>, Result<Good>, Loose>;
    // @ts-expect-error an `any` accepted value is refused
    expectTypeOf<AnyValue>().toEqualTypeOf<AnyValueExpected>();
  });

  it("pins public and forwarding results to the source result", () => {
    expectTypeOf<
      LibraryParserTripleIdentityFacts<GoodParser, GoodParser, GoodParser>
    >().toEqualTypeOf<LibraryParserTripleIdentityExpected<Result<Good>, Result<Good>>>();
    type Different = LibraryParserTripleIdentityFacts<GoodParser, OtherParser, OtherParser>;
    type DifferentExpected = LibraryParserTripleIdentityExpected<
      Result<Good>,
      Result<{ readonly id: number }>
    >;
    // @ts-expect-error a public result other than the source result is refused
    expectTypeOf<Different>().toEqualTypeOf<DifferentExpected>();
  });

  it("requires boolean ok, string refusals and a concrete accepted value", () => {
    expectTypeOf<CheckedResultFacts<GoodParser>>().toEqualTypeOf<CheckedResultExpected>();
    // @ts-expect-error an `any` accepted value is refused
    expectTypeOf<CheckedResultFacts<LooseValueParser>>().toEqualTypeOf<CheckedResultExpected>();
    // @ts-expect-error non-string refusals are refused
    expectTypeOf<CheckedResultFacts<LooseErrorsParser>>().toEqualTypeOf<CheckedResultExpected>();
  });
});

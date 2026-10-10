const imports = 'import { Context, Data, Effect, Exit, Layer, Match, Predicate } from "effect";';

export const nativeEffectQualityFixtures = [
  {
    rule: "no-manual-effect-error-tag",
    expected: ["refused", true],
    safe: `${imports}
class Refused extends Data.TaggedError("Refused") {}
class Unhandled extends Data.TaggedError("Unhandled") {}
const recover = error => Effect.fail(error).pipe(
  Effect.catchTag("Refused", () => Effect.succeed("refused")));
export const qualify = async () => [await Effect.runPromise(recover(new Refused())),
  Exit.isFailure(await Effect.runPromiseExit(recover(new Unhandled())))];`,
    bad: `${imports}
class Refused extends Data.TaggedError("Refused") {}
class Unhandled extends Data.TaggedError("Unhandled") {}
const recover = error => Effect.fail(error).pipe(
  Effect.catch(error => error._tag === "Refused" ? Effect.succeed("refused") : Effect.fail(error)));
export const qualify = async () => [await Effect.runPromise(recover(new Refused())),
  Exit.isFailure(await Effect.runPromiseExit(recover(new Unhandled())))];`,
  },
  {
    rule: "no-manual-tag-comparison",
    expected: [true, false],
    safe: `${imports}
const { Ready, Refused } = Data.taggedEnum();
export const qualify = () => [Ready({ value: 1 }), Refused()].map(value => Match.value(value).pipe(
  Match.tagsExhaustive({ Ready: () => true, Refused: () => false })));`,
    bad: `${imports}
const { Ready, Refused } = Data.taggedEnum();
export const qualify = () => [Ready({ value: 1 }), Refused()].map(value => value._tag === "Ready");`,
  },
  {
    rule: "no-manual-tagged-construction",
    expected: 1,
    safe: `${imports}
const { Ready } = Data.taggedEnum();
export const qualify = () => Ready({ value: 1 }).value;`,
    bad: `${imports}
export const qualify = () => ({ _tag: "Ready", value: 1 }).value;`,
  },
  {
    rule: "no-service-constructor-imports",
    expected: 42,
    safe: `${imports}
import { Database, DatabaseLive } from "./services.mjs";
export const qualify = () => Effect.runPromise(Effect.gen(function* () {
  const database = yield* Database;
  return database.read();
}).pipe(Effect.provide(DatabaseLive)));`,
    bad: `${imports}
import { Database, makeDatabase } from "./services.mjs";
export const qualify = () => Effect.runPromise(Effect.gen(function* () {
  const database = yield* Database;
  return database.read();
}).pipe(Effect.provideService(Database, makeDatabase())));`,
  },
  {
    rule: "prefer-effect-match",
    expected: "ready",
    safe: `${imports}
export const qualify = () => Match.value("ready").pipe(
  Match.when("ready", () => "ready"), Match.when("refused", () => "refused"),
  Match.exhaustive);`,
    bad: `${imports}
export const qualify = () => {
  const state = "ready";
  return state === "ready" ? "ready" : state === "refused" ? "refused" : "invalid";
};`,
  },
];

export const nativeEffectServiceFixture = `${imports}
export const Database = Context.Service("KeikoNativeQualityDatabase");
export const makeDatabase = () => ({ read: () => 42 });
export const DatabaseLive = Layer.succeed(Database, makeDatabase());`;

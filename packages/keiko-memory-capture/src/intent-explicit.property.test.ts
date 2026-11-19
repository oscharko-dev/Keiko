import { expect, it } from "vitest";

import type { MemoryId, MemoryProposalId, UserId } from "@oscharko-dev/keiko-contracts/memory";

import {
  checkProperty,
  propertySettings,
  shrinkRecord,
} from "../../../tests/support/property-testing.js";
import { tryExtractForget } from "./intent-explicit.js";
import type { CaptureContext } from "./types.js";

const MEMORY_ID = "fixture-memory" as MemoryId;
const CONTEXT: CaptureContext = {
  userId: "fixture-user" as UserId,
  nowMs: 1,
  newMemoryId: () => MEMORY_ID,
  newProposalId: () => "fixture-proposal" as MemoryProposalId,
};

interface PoliteForgetInput {
  readonly de: string;
  readonly en: string;
  readonly spaces: string;
  readonly punctuation: string;
  readonly followUp: string;
}

it("recognizes polite forgets while keeping negated German and English requests out", async () => {
  const name = "polite-forget-negation";
  const { runs } = propertySettings({ name });
  let explicit = 0;
  let negated = 0;
  await checkProperty<PoliteForgetInput>({
    name,
    runs,
    generate: (random) => ({
      de: random.pick(["meine Formatvorliebe", "den Bericht", "diese Notizen"]),
      en: random.pick(["my formatting preference", "the report", "these notes"]),
      spaces: random.pick([" ", "   ", "\t"]),
      punctuation: random.pick(["", ".", "!"]),
      followUp: random.pick([". Danke.", ", vielen Dank.", " – das ist mir wichtig."]),
    }),
    shrink: shrinkRecord({
      spaces: (value) => (value === " " ? [] : [" "]),
      followUp: (value) => (value === ". Danke." ? [] : [". Danke."]),
    }),
    property: ({ de, en, spaces, punctuation, followUp }) => {
      const targets: string[] = [];
      const forgetResolver = (target: string): readonly MemoryId[] => {
        targets.push(target);
        return [MEMORY_ID];
      };
      const german = `Bitte${spaces}vergiss ${de}`;
      const english = `Please${spaces}forget ${en}`;
      for (const statement of [`${german}${punctuation}`, `${english}${punctuation}`]) {
        expect(tryExtractForget(statement, CONTEXT, { forgetResolver })).toMatchObject({
          kind: "forget",
          requiresConfirmation: false,
        });
        explicit += 1;
      }
      expect(targets).toEqual([de, en]);
      for (const statement of [
        `${german} nicht${followUp}`,
        `Please${spaces}don't forget ${en}${punctuation}`,
        `Please${spaces}forget not ${en}${punctuation}`,
      ]) {
        expect(tryExtractForget(statement, CONTEXT, { forgetResolver })).toBeNull();
        negated += 1;
      }
      expect(targets).toEqual([de, en]);
    },
  });
  expect(explicit).toBe(2 * runs);
  expect(negated).toBe(3 * runs);
});

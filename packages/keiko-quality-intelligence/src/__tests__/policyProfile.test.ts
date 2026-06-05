import { describe, expect, it } from "vitest";

import {
  ALL_POLICY_PROFILES,
  bankingDefault,
  insuranceDefault,
  regressionDefault,
} from "../domain/policyProfile.js";

describe("policy profiles", () => {
  it("expose three named profiles", () => {
    expect(ALL_POLICY_PROFILES.length).toBe(3);
    expect(ALL_POLICY_PROFILES).toContain(bankingDefault);
    expect(ALL_POLICY_PROFILES).toContain(insuranceDefault);
    expect(ALL_POLICY_PROFILES).toContain(regressionDefault);
  });

  it("are deeply frozen", () => {
    for (const profile of ALL_POLICY_PROFILES) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.priorityKeywords)).toBe(true);
      for (const bucket of profile.priorityKeywords) {
        expect(Object.isFrozen(bucket)).toBe(true);
      }
      expect(Object.isFrozen(profile.riskKeywords)).toBe(true);
      for (const value of Object.values(profile.riskKeywords)) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
  });

  it("expose a stable id and display label per profile", () => {
    for (const profile of ALL_POLICY_PROFILES) {
      expect(profile.id.length).toBeGreaterThan(0);
      expect(profile.displayLabel.length).toBeGreaterThan(0);
    }
  });
});

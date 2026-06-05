import { describe, expect, it } from "vitest";
import {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
  QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS,
  findQualityIntelligenceWorkflowDescriptor,
} from "../descriptors.js";

describe("QI workflow descriptors", () => {
  it("exposes exactly 4 descriptors", () => {
    expect(QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS).toHaveLength(4);
  });

  it("descriptor IDs are unique and stable", () => {
    const ids = QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS.map((d) => d.workflowId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_VALIDATION_WORKFLOW_DESCRIPTOR.workflowId);
    expect(ids).toContain(QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR.workflowId);
  });

  it("each descriptor has a non-empty stage list", () => {
    for (const descriptor of QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS) {
      expect(descriptor.stageNames.length).toBeGreaterThan(0);
    }
  });

  it("descriptors are frozen at the top level", () => {
    expect(Object.isFrozen(QUALITY_INTELLIGENCE_WORKFLOW_DESCRIPTORS)).toBe(true);
  });

  it("findQualityIntelligenceWorkflowDescriptor returns the right descriptor by id", () => {
    const found = findQualityIntelligenceWorkflowDescriptor(
      QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR.workflowId,
    );
    expect(found).toBe(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR);
  });

  it("findQualityIntelligenceWorkflowDescriptor throws for unknown id", () => {
    // @ts-expect-error — intentionally passing an invalid id
    expect(() => findQualityIntelligenceWorkflowDescriptor("qi:nonexistent")).toThrow();
  });
});

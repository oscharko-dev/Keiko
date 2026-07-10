import type {
  FeedbackCategory,
  FeedbackFeatureArea,
  FeedbackImpact,
  FeedbackPlatform,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import type { FeedbackBrowserDraftV1 } from "@/lib/feedback-api";
import type { FeedbackMessageKey } from "./feedback-i18n-messages.en";

export type FeedbackTextField =
  | "productVersion"
  | "browserDescription"
  | "handwrittenEvidence"
  | "title"
  | "description"
  | "reproductionSteps"
  | "expectedBehavior"
  | "actualBehavior";

export type FeedbackOptionalTextField = "browserDescription" | "handwrittenEvidence";

export type FeedbackSelectField = "category" | "platform" | "featureArea" | "impact";
export type FeedbackTextControlElement = HTMLInputElement | HTMLTextAreaElement;

export interface FeedbackSelectOption<T extends string = string> {
  readonly value: T;
  readonly label: FeedbackMessageKey;
}

export const CATEGORY_OPTIONS = [
  { value: "defect", label: "feedback.option.category.defect" },
  { value: "performance", label: "feedback.option.category.performance" },
  { value: "usability", label: "feedback.option.category.usability" },
  { value: "compatibility", label: "feedback.option.category.compatibility" },
  { value: "other", label: "feedback.option.category.other" },
] as const satisfies readonly FeedbackSelectOption<FeedbackCategory>[];

export const PLATFORM_OPTIONS = [
  { value: "macOS", label: "feedback.option.platform.macOS" },
  { value: "Windows", label: "feedback.option.platform.windows" },
  { value: "Linux", label: "feedback.option.platform.linux" },
  { value: "Other", label: "feedback.option.platform.other" },
] as const satisfies readonly FeedbackSelectOption<FeedbackPlatform>[];

export const FEATURE_OPTIONS = [
  { value: "installation", label: "feedback.option.feature.installation" },
  { value: "model-configuration", label: "feedback.option.feature.modelConfiguration" },
  { value: "conversation", label: "feedback.option.feature.conversation" },
  { value: "files", label: "feedback.option.feature.files" },
  { value: "editor", label: "feedback.option.feature.editor" },
  { value: "terminal", label: "feedback.option.feature.terminal" },
  { value: "browser", label: "feedback.option.feature.browser" },
  { value: "local-knowledge", label: "feedback.option.feature.localKnowledge" },
  { value: "memory", label: "feedback.option.feature.memory" },
  { value: "git-delivery", label: "feedback.option.feature.gitDelivery" },
  { value: "updates", label: "feedback.option.feature.updates" },
  { value: "voice", label: "feedback.option.feature.voice" },
  { value: "other", label: "feedback.option.feature.other" },
] as const satisfies readonly FeedbackSelectOption<FeedbackFeatureArea>[];

export const IMPACT_OPTIONS = [
  { value: "Blocks installation or startup", label: "feedback.option.impact.installation" },
  { value: "Blocks model or credential setup", label: "feedback.option.impact.modelSetup" },
  { value: "Blocks core workflow", label: "feedback.option.impact.coreBlock" },
  { value: "Degrades core workflow", label: "feedback.option.impact.coreDegrade" },
  { value: "Visual or usability issue", label: "feedback.option.impact.usability" },
  { value: "Unknown", label: "feedback.option.impact.unknown" },
] as const satisfies readonly FeedbackSelectOption<FeedbackImpact>[];

export const FEEDBACK_TEXT_FIELDS = [
  ["productVersion", "feedback.form.productVersion", false, true],
  ["browserDescription", "feedback.form.browserDescription", false, false],
  ["handwrittenEvidence", "feedback.form.handwrittenEvidence", true, false],
  ["title", "feedback.form.summaryTitle", false, true],
  ["description", "feedback.form.summaryDescription", true, true],
  ["reproductionSteps", "feedback.form.steps", true, true],
  ["expectedBehavior", "feedback.form.expected", true, true],
  ["actualBehavior", "feedback.form.actual", true, true],
] as const satisfies readonly (readonly [
  FeedbackTextField,
  FeedbackMessageKey,
  boolean,
  boolean,
])[];

const FEEDBACK_TEXT_FIELD_IDS = new Set<string>(FEEDBACK_TEXT_FIELDS.map(([field]) => field));
const FEEDBACK_OPTIONAL_TEXT_FIELD_IDS = new Set<string>([
  "browserDescription",
  "handwrittenEvidence",
]);

export function isFeedbackTextField(value: string): value is FeedbackTextField {
  return FEEDBACK_TEXT_FIELD_IDS.has(value);
}

export function isFeedbackOptionalTextField(value: string): value is FeedbackOptionalTextField {
  return FEEDBACK_OPTIONAL_TEXT_FIELD_IDS.has(value);
}

export function initialFeedbackDraft(): FeedbackBrowserDraftV1 {
  return {
    schemaVersion: "1",
    category: "defect",
    title: "",
    description: "",
    reproductionSteps: "",
    expectedBehavior: "",
    actualBehavior: "",
    productVersion: "",
    platform: "Other",
    featureArea: "other",
    impact: "Unknown",
  };
}

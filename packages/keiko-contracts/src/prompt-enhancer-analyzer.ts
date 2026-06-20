// Deterministic Prompt Enhancer analyzer (Issue #1309, ADR-0044 §3 / blueprint §2).
//
// `analyzePrompt` converts a raw, untrusted user draft into a normalized `PromptTaskAnalysis`
// WITHOUT any model call, IO, clock read, or randomness. Classification is rule-backed and
// explainable: every dimension is driven by a closed keyword/structure table, and every detector
// that fires is recorded in `signals` so the result is auditable and testable. No raw input text is
// echoed into the analysis — only bounded metadata (lengths) and fixed signal labels — keeping the
// output content-light and aligned with the safe-error discipline (ADR-0044 §5).
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports. The module reuses the
// same-package `normalizePromptDraft` (which composes `stripUnsafeFormatChars`) for input hardening.

import {
  type ClarificationOrAssumption,
  type GroundingNeed,
  type GroundingSignal,
  type MissingContextTopic,
  type MissingInformationStrategy,
  type OutputFormat,
  type OutputFormatHint,
  type OutputSchemaDescriptor,
  type PromptClassificationSignal,
  type PromptCriticality,
  type PromptDomain,
  type PromptEnhancementProfileId,
  type PromptEnhancementRequest,
  type PromptRiskClass,
  type PromptSignalStrength,
  type PromptTaskAnalysis,
  type PromptTaskClass,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_MISSING_CONTEXT_MAX_CHARS,
  isSafetyCriticalDomain,
  normalizePromptDraft,
} from "./prompt-enhancer.js";

// ─── Normalized analysis view ────────────────────────────────────────────────────
interface AnalysisView {
  readonly normalizedLength: number;
  readonly lower: string;
  readonly hasConnectedContext: boolean;
  readonly meaningfulTokenCount: number;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "this",
  "that",
  "it",
  "please",
  "can",
  "you",
  "me",
  "my",
  "i",
  "do",
  "how",
  "what",
  "why",
]);

function countMeaningfulTokens(lower: string): number {
  const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  let count = 0;
  for (const token of tokens) {
    if (token.length >= 3 && !STOP_WORDS.has(token)) count += 1;
  }
  return count;
}

function buildView(normalized: string, request: PromptEnhancementRequest): AnalysisView {
  const lower = normalized.toLowerCase();
  return {
    normalizedLength: normalized.length,
    lower,
    hasConnectedContext: request.input.hasConnectedContext === true,
    meaningfulTokenCount: countMeaningfulTokens(lower),
  };
}

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

const countMatches = (haystack: string, needles: readonly string[]): number => {
  let count = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) count += 1;
  }
  return count;
};

// ─── Task-class detection ────────────────────────────────────────────────────────
// Ordered by precedence: when two rules tie on match count, the earlier rule wins. `strong` phrases
// mark an unambiguous intent and lift confidence to "strong".
interface TaskClassRule {
  readonly taskClass: PromptTaskClass;
  readonly strong: readonly string[];
  readonly weak: readonly string[];
}

const TASK_CLASS_RULES: readonly TaskClassRule[] = [
  {
    taskClass: "prompt-optimization",
    strong: [
      "improve this prompt",
      "optimize the prompt",
      "rewrite the prompt",
      "meta-prompt",
      "system prompt for",
    ],
    weak: ["prompt engineering", "better prompt", "prompt template"],
  },
  {
    taskClass: "code-debugging",
    strong: [
      "debug",
      "fix this bug",
      "stack trace",
      "traceback",
      "why does this fail",
      "not working",
    ],
    weak: ["error", "exception", "throws", "undefined is not", "segfault"],
  },
  {
    taskClass: "code-architecture",
    strong: ["system design", "design the system", "software architecture", "architecture for"],
    weak: ["scalable", "microservice", "design pattern", "trade-offs between", "high-level design"],
  },
  {
    taskClass: "code-generation",
    strong: [
      "write a function",
      "write code",
      "implement a",
      "generate code",
      "write a script",
      "create a class",
    ],
    weak: [
      "function that",
      "function to",
      "function for",
      "code that",
      "a method to",
      "a class to",
      "an algorithm",
      "write a program",
      "build an api",
      "refactor",
      "snippet",
    ],
  },
  {
    taskClass: "structured-extraction",
    strong: ["extract the", "parse the", "pull out the", "extract fields", "into json"],
    weak: ["extract", "parse", "list all the", "structured output"],
  },
  {
    taskClass: "summarization",
    strong: ["summarize", "tl;dr", "tldr", "give me a summary", "condense"],
    weak: ["summary", "key points", "in brief", "abstract of"],
  },
  {
    taskClass: "data-analysis",
    strong: [
      "analyze this data",
      "analyze the dataset",
      "statistical analysis",
      "correlation between",
    ],
    weak: ["dataset", "regression", "aggregate", "pivot", "trend", "metrics"],
  },
  {
    taskClass: "rag-question-answering",
    strong: [
      "based on the provided",
      "according to the document",
      "from the attached",
      "using the document",
      "in the provided text",
    ],
    weak: ["from these files", "from the context", "in the attached"],
  },
  {
    taskClass: "research",
    strong: [
      "deep research",
      "comprehensive overview",
      "literature review",
      "state of the art",
      "survey of",
    ],
    weak: ["research", "investigate", "background on", "explore the topic"],
  },
  {
    taskClass: "creative-writing",
    strong: [
      "write a poem",
      "write a story",
      "write a song",
      "write lyrics",
      "screenplay",
      "short story",
    ],
    weak: ["poem", "fiction", "creative", "imagine a", "tale"],
  },
  {
    taskClass: "writing-editing",
    strong: ["write an email", "draft a", "proofread", "rewrite this", "rephrase"],
    weak: ["edit", "improve this text", "make this clearer", "polish", "tone"],
  },
  {
    taskClass: "decision-support",
    strong: ["should i", "pros and cons", "help me decide", "which is better", "compare options"],
    weak: ["recommend", "trade-offs", "decision", "evaluate options"],
  },
  {
    taskClass: "agentic-tool-use",
    strong: ["use the tool", "call the api", "automate", "take actions", "as an agent"],
    weak: ["execute", "browse", "fetch and", "step by step using tools", "orchestrate"],
  },
];

interface TaskClassResult {
  readonly taskClass: PromptTaskClass;
  readonly confidence: PromptSignalStrength;
}

function scoreTaskClassRule(
  rule: TaskClassRule,
  lower: string,
): { score: number; strong: boolean } {
  const strongHits = countMatches(lower, rule.strong);
  const weakHits = countMatches(lower, rule.weak);
  return { score: strongHits * 2 + weakHits, strong: strongHits > 0 };
}

function detectBaseTaskClass(lower: string): TaskClassResult {
  let best: { rule: TaskClassRule; score: number; strong: boolean } | undefined;
  for (const rule of TASK_CLASS_RULES) {
    const { score, strong } = scoreTaskClassRule(rule, lower);
    if (score > 0 && (best === undefined || score > best.score)) {
      best = { rule, score, strong };
    }
  }
  if (best === undefined) {
    return { taskClass: "factual-qa", confidence: "weak" };
  }
  const confidence: PromptSignalStrength = best.strong
    ? "strong"
    : best.score >= 2
      ? "moderate"
      : "weak";
  return { taskClass: best.rule.taskClass, confidence };
}

// ─── Domain detection ────────────────────────────────────────────────────────────
interface DomainRule {
  readonly domain: PromptDomain;
  readonly keywords: readonly string[];
}

// Ordered so consequential domains win ties (drives criticality). `general` is the implicit default.
const DOMAIN_RULES: readonly DomainRule[] = [
  {
    domain: "legal",
    keywords: [
      "legal",
      "lawsuit",
      "liable",
      "liability",
      "contract clause",
      "attorney",
      "court",
      "gdpr",
      "regulation",
      "copyright",
      "patent",
    ],
  },
  {
    domain: "medical",
    keywords: [
      "medical",
      "symptom",
      "diagnos",
      "disease",
      "dosage",
      "prescription",
      "patient",
      "treatment",
      "medication",
      "clinical",
    ],
  },
  {
    domain: "finance",
    keywords: [
      "invest",
      "stock price",
      "portfolio",
      "mortgage",
      "tax return",
      "trading",
      "retirement",
      "interest rate",
      "loan",
    ],
  },
  {
    domain: "security",
    keywords: [
      "vulnerab",
      "exploit",
      "penetration test",
      "malware",
      "sql injection",
      "xss",
      "csrf",
      "authentication",
      "encryption",
      "secrets management",
    ],
  },
  {
    domain: "data-science",
    keywords: [
      "machine learning",
      "neural network",
      "training data",
      "pandas",
      "regression model",
      "feature engineering",
    ],
  },
  {
    domain: "science",
    keywords: ["physics", "chemistry", "biology", "hypothesis", "theorem", "experiment"],
  },
  {
    domain: "business",
    keywords: ["marketing", "sales", "revenue", "business plan", "startup", "customer", "kpi"],
  },
  {
    domain: "education",
    keywords: ["teach", "lesson", "homework", "student", "tutorial", "curriculum"],
  },
  { domain: "creative", keywords: ["poem", "story", "novel", "song", "fiction", "screenplay"] },
  {
    domain: "software",
    keywords: [
      "code",
      "function",
      "typescript",
      "python",
      "javascript",
      "api",
      "database",
      "compile",
      "react",
      "algorithm",
    ],
  },
];

function detectDomain(lower: string): PromptDomain {
  let best: { domain: PromptDomain; score: number } | undefined;
  for (const rule of DOMAIN_RULES) {
    const score = countMatches(lower, rule.keywords);
    if (score > 0 && (best === undefined || score > best.score)) {
      best = { domain: rule.domain, score };
    }
  }
  return best?.domain ?? "general";
}

// ─── Safety-critical override + criticality ──────────────────────────────────────
// A prompt is treated as seeking consequential advice in a safety-critical domain only when it is an
// inherently decision-making task OR it contains an explicit advice cue. Neutral factual, research,
// summarization, or extraction tasks that merely mention a safety-critical domain are NOT escalated
// to the safety-critical task class (they remain their base class with an elevated criticality from
// the domain). This avoids over-escalating, e.g., "Explain the history of medical terminology".
const CONSEQUENTIAL_TASK_CLASSES: ReadonlySet<PromptTaskClass> = new Set(["decision-support"]);

const ADVICE_CUES: readonly string[] = [
  "should i",
  "what should i do",
  "is it legal",
  "am i liable",
  "diagnose",
  "what dose",
  "how much should i invest",
  "is it safe",
  "my rights",
  "legal rights",
  "can i sue",
  "recommended treatment",
  "tax implications",
  "legal advice",
  "medical advice",
  "financial advice",
];

function isAdviceSeeking(taskClass: PromptTaskClass, lower: string): boolean {
  return CONSEQUENTIAL_TASK_CLASSES.has(taskClass) || containsAny(lower, ADVICE_CUES);
}

function deriveCriticality(
  domain: PromptDomain,
  taskClass: PromptTaskClass,
  riskFlags: readonly PromptRiskClass[],
): PromptCriticality {
  // Critical is reserved for consequential advice in a safety-critical domain (the safety-critical
  // task class). A safety-critical DOMAIN with a non-advice task, an agentic task, or any risk flag
  // is elevated — heightened awareness without the strongest gate.
  if (taskClass === "safety-critical") return "critical";
  if (isSafetyCriticalDomain(domain) || taskClass === "agentic-tool-use" || riskFlags.length > 0) {
    return "elevated";
  }
  return "standard";
}

// ─── Risk flags (lexical signals) ────────────────────────────────────────────────
const INSTRUCTION_OVERRIDE_CUES: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard previous",
  "disregard the above instructions",
  "ignore your instructions",
  "ignore the system prompt",
  "you are now ",
  "developer mode",
  "jailbreak",
];
const TOOL_AUTHORITY_CUES: readonly string[] = [
  "run this command",
  "execute this command",
  "sudo ",
  "rm -rf",
  "install and run",
  "grant yourself",
  "give yourself access",
  "deploy to production",
  "run the script",
  "execute the following",
];
const EGRESS_CUES: readonly string[] = [
  "exfiltrate",
  "send the data to",
  "upload to",
  "post to http",
  "curl http",
  "make a request to http",
  "send it to my server",
  "download from and run",
];

function detectRiskFlags(
  lower: string,
  domain: PromptDomain,
  taskClass: PromptTaskClass,
): readonly PromptRiskClass[] {
  const flags: PromptRiskClass[] = [];
  if (containsAny(lower, INSTRUCTION_OVERRIDE_CUES)) flags.push("instruction-override-suspected");
  if (containsAny(lower, TOOL_AUTHORITY_CUES)) flags.push("tool-authority-requested");
  if (containsAny(lower, EGRESS_CUES)) flags.push("egress-requested");
  if (isSafetyCriticalDomain(domain) && isAdviceSeeking(taskClass, lower)) {
    flags.push("safety-critical-advice");
  }
  return flags;
}

// ─── Classification orchestration ────────────────────────────────────────────────
interface Classification {
  readonly taskClass: PromptTaskClass;
  readonly confidence: PromptSignalStrength;
  readonly domain: PromptDomain;
  readonly criticality: PromptCriticality;
  readonly riskFlags: readonly PromptRiskClass[];
}

function classify(view: AnalysisView): Classification {
  const domain = detectDomain(view.lower);
  const base = detectBaseTaskClass(view.lower);
  const safetyOverride =
    isSafetyCriticalDomain(domain) && isAdviceSeeking(base.taskClass, view.lower);
  const taskClass: PromptTaskClass = safetyOverride ? "safety-critical" : base.taskClass;
  const confidence: PromptSignalStrength = safetyOverride ? "strong" : base.confidence;
  const riskFlags = detectRiskFlags(view.lower, domain, taskClass);
  const criticality = deriveCriticality(domain, taskClass, riskFlags);
  return { taskClass, confidence, domain, criticality, riskFlags };
}

// ─── Grounding need (AC3) ────────────────────────────────────────────────────────
const TEMPORAL_RECENCY_CUES: readonly string[] = [
  "today",
  "right now",
  "currently",
  "latest",
  "most recent",
  "this year",
  "this week",
  "as of",
  "up to date",
  "up-to-date",
  "current ",
];
const NAMED_CURRENT_CUES: readonly string[] = [
  "breaking news",
  "who won",
  "who is the current",
  "election",
  "just released",
  "newest",
];
const MARKET_PRICE_CUES: readonly string[] = [
  "stock price",
  "exchange rate",
  "market cap",
  "price of",
  "how much does it cost",
];
const SUPPLIED_CONTEXT_CUES: readonly string[] = [
  "attached",
  "the provided",
  "this document",
  "these files",
  "the text below",
  "the context above",
  "the snippet",
];
const RETRIEVAL_CUES: readonly string[] = [
  "search for",
  "look up",
  "find sources",
  "cite sources",
  "with citations",
];
const SELF_CONTAINED_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "code-generation",
  "creative-writing",
  "summarization",
  "structured-extraction",
  "prompt-optimization",
]);

function collectGroundingSignals(view: AnalysisView): GroundingSignal[] {
  const signals: GroundingSignal[] = [];
  if (containsAny(view.lower, TEMPORAL_RECENCY_CUES)) signals.push("temporal-recency-term");
  if (containsAny(view.lower, NAMED_CURRENT_CUES)) signals.push("named-current-event");
  if (containsAny(view.lower, MARKET_PRICE_CUES)) signals.push("market-or-price");
  if (/https?:\/\/|www\./u.test(view.lower)) signals.push("url-reference");
  if (view.hasConnectedContext || containsAny(view.lower, SUPPLIED_CONTEXT_CUES)) {
    signals.push("supplied-context-reference");
  }
  if (containsAny(view.lower, RETRIEVAL_CUES)) signals.push("retrieval-cue");
  return signals;
}

function isVolatileGrounding(signals: readonly GroundingSignal[]): boolean {
  return (
    signals.includes("temporal-recency-term") ||
    signals.includes("named-current-event") ||
    signals.includes("market-or-price")
  );
}

function detectGroundingNeed(view: AnalysisView, taskClass: PromptTaskClass): GroundingNeed {
  const signals = collectGroundingSignals(view);
  const volatile = isVolatileGrounding(signals);
  if (volatile || signals.includes("url-reference")) {
    return { kind: "external-current", volatile, signals };
  }
  if (signals.includes("supplied-context-reference")) {
    return { kind: "supplied-context", volatile: false, signals };
  }
  if (
    signals.includes("retrieval-cue") ||
    taskClass === "research" ||
    taskClass === "rag-question-answering"
  ) {
    return {
      kind: "external-knowledge",
      volatile: false,
      signals: appendSignal(signals, "retrieval-cue"),
    };
  }
  if (SELF_CONTAINED_CLASSES.has(taskClass)) {
    return { kind: "none", volatile: false, signals: ["self-contained-task"] };
  }
  return { kind: "external-knowledge", volatile: false, signals: ["no-external-signal"] };
}

function appendSignal(
  signals: readonly GroundingSignal[],
  signal: GroundingSignal,
): readonly GroundingSignal[] {
  return signals.includes(signal) ? signals : [...signals, signal];
}

// ─── Output schema descriptor ────────────────────────────────────────────────────
interface OutputHintRule {
  readonly hint: OutputFormatHint;
  readonly format: OutputFormat;
  readonly keywords: readonly string[];
}

const OUTPUT_HINT_RULES: readonly OutputHintRule[] = [
  { hint: "explicit-json", format: "json", keywords: ["json", "as json", "in json"] },
  { hint: "explicit-yaml", format: "yaml", keywords: ["yaml"] },
  { hint: "explicit-csv", format: "csv", keywords: ["csv", "comma-separated"] },
  { hint: "explicit-table", format: "table", keywords: ["as a table", "in a table", "tabular"] },
  { hint: "explicit-code", format: "code", keywords: ["code block", "a snippet", "as code"] },
  {
    hint: "explicit-list",
    format: "list",
    keywords: ["bullet points", "bulleted list", "numbered list", "as a list"],
  },
  { hint: "explicit-markdown", format: "markdown", keywords: ["in markdown", "as markdown"] },
];

const DEFAULT_FORMAT_BY_CLASS: Readonly<Partial<Record<PromptTaskClass, OutputFormat>>> = {
  "code-generation": "code",
  "code-debugging": "code",
  "structured-extraction": "json",
  "data-analysis": "table",
  "creative-writing": "prose",
  "writing-editing": "prose",
  summarization: "markdown",
  research: "markdown",
  "decision-support": "markdown",
};

const STRUCTURED_FORMATS: ReadonlySet<OutputFormat> = new Set(["json", "yaml", "csv", "table"]);

function detectOutputSchema(lower: string, taskClass: PromptTaskClass): OutputSchemaDescriptor {
  const hints: OutputFormatHint[] = [];
  let format: OutputFormat | undefined;
  for (const rule of OUTPUT_HINT_RULES) {
    if (containsAny(lower, rule.keywords)) {
      hints.push(rule.hint);
      format ??= rule.format;
    }
  }
  if (containsAny(lower, ["schema", "the fields", "format:"])) hints.push("schema-keyword");
  const resolved: OutputFormat = format ?? DEFAULT_FORMAT_BY_CLASS[taskClass] ?? "unspecified";
  return {
    format: resolved,
    structured: STRUCTURED_FORMATS.has(resolved),
    hints: hints.length > 0 ? hints : ["no-format-signal"],
  };
}

// ─── Missing context (AC4) ───────────────────────────────────────────────────────
const SCOPE_REFERENCE_CUES: readonly string[] = [
  "this file",
  "the file",
  "this code",
  "the code",
  "the document",
  "above",
  "below",
  "attached",
  "the provided",
];
const AUDIENCE_CUES: readonly string[] = ["for ", "audience", "readers", "to a ", "for a "];
const CONSTRAINT_CUES: readonly string[] = [
  "using ",
  " in ",
  "language",
  "within",
  "must ",
  "should ",
  "framework",
  "library",
  "without ",
  "no more than",
];
const CRITERIA_CUES: readonly string[] = [
  "criteria",
  "goal",
  "objective",
  "optimize for",
  "prioritize",
  "based on",
];
const FORMAT_SENSITIVE_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "structured-extraction",
  "data-analysis",
]);
const AUDIENCE_SENSITIVE_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "writing-editing",
  "creative-writing",
]);
const CONSTRAINT_SENSITIVE_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "code-generation",
  "code-architecture",
]);
const CRITERIA_SENSITIVE_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "decision-support",
  "research",
]);
const MAX_MISSING_TOPICS = 4;

const lacksSubject = (view: AnalysisView): boolean =>
  view.normalizedLength < 12 || view.meaningfulTokenCount < 3;

const lacksDataSource = (view: AnalysisView): boolean =>
  containsAny(view.lower, SCOPE_REFERENCE_CUES) && !view.hasConnectedContext;

// A format-sensitive task (structured extraction, data analysis) is missing its output format when
// the user gave no explicit format hint. The resolved `format` is checked via the hints array rather
// than the final value, because these classes carry a sensible default format that would otherwise
// mask the absence of an explicit signal (`no-format-signal` is present exactly when none was found).
const lacksOutputFormat = (
  taskClass: PromptTaskClass,
  outputSchema: OutputSchemaDescriptor,
): boolean =>
  FORMAT_SENSITIVE_CLASSES.has(taskClass) && outputSchema.hints.includes("no-format-signal");

const lacksAudience = (view: AnalysisView, taskClass: PromptTaskClass): boolean =>
  AUDIENCE_SENSITIVE_CLASSES.has(taskClass) && !containsAny(view.lower, AUDIENCE_CUES);

const lacksConstraints = (view: AnalysisView, taskClass: PromptTaskClass): boolean =>
  CONSTRAINT_SENSITIVE_CLASSES.has(taskClass) && !containsAny(view.lower, CONSTRAINT_CUES);

const lacksSuccessCriteria = (view: AnalysisView, taskClass: PromptTaskClass): boolean =>
  CRITERIA_SENSITIVE_CLASSES.has(taskClass) && !containsAny(view.lower, CRITERIA_CUES);

function detectMissingTopics(
  view: AnalysisView,
  classification: Classification,
  outputSchema: OutputSchemaDescriptor,
): readonly MissingContextTopic[] {
  const cls = classification.taskClass;
  const topics: MissingContextTopic[] = [];
  if (lacksSubject(view)) topics.push("subject");
  if (lacksDataSource(view)) topics.push("data-source");
  if (lacksOutputFormat(cls, outputSchema)) topics.push("output-format");
  if (lacksAudience(view, cls)) topics.push("audience");
  if (lacksConstraints(view, cls)) topics.push("constraints");
  if (lacksSuccessCriteria(view, cls)) topics.push("success-criteria");
  return topics.slice(0, MAX_MISSING_TOPICS);
}

const CLARIFICATION_TEMPLATES: Readonly<Record<MissingContextTopic, string>> = {
  subject: "What specific subject or task should this prompt address?",
  scope: "Which part of the work should the task focus on?",
  audience: "Who is the intended audience for the output?",
  "output-format": "What output format is expected (for example JSON, a table, or prose)?",
  constraints: "Are there language, framework, or length constraints to honor?",
  "data-source": "Which files, documents, or sources should ground the answer?",
  "success-criteria": "What defines a successful outcome for this task?",
};

const ASSUMPTION_TEMPLATES: Readonly<Record<MissingContextTopic, string>> = {
  subject: "Assuming the broadest reasonable interpretation of the requested subject.",
  scope: "Assuming the task applies to the most relevant available scope.",
  audience: "Assuming a general professional audience.",
  "output-format": "Assuming a structured format appropriate to the task.",
  constraints: "Assuming no constraints beyond standard best practices.",
  "data-source": "Assuming the answer should rely only on supplied context, with gaps flagged.",
  "success-criteria": "Assuming correctness and completeness are the primary success criteria.",
};

function toMissingContext(
  topics: readonly MissingContextTopic[],
  strategy: MissingInformationStrategy,
): readonly ClarificationOrAssumption[] {
  return topics.map((topic) =>
    strategy === "clarify"
      ? {
          kind: "clarification",
          topic,
          question: CLARIFICATION_TEMPLATES[topic].slice(0, PROMPT_MISSING_CONTEXT_MAX_CHARS),
        }
      : {
          kind: "assumption",
          topic,
          statement: ASSUMPTION_TEMPLATES[topic].slice(0, PROMPT_MISSING_CONTEXT_MAX_CHARS),
        },
  );
}

// ─── Profile recommendation ──────────────────────────────────────────────────────
// Deterministic task-class → profile map. A critical criticality (safety-critical domain) always
// escalates to the safety-critical profile regardless of the base class.
const PROFILE_BY_TASK_CLASS: Readonly<Record<PromptTaskClass, PromptEnhancementProfileId>> = {
  "factual-qa": "precise",
  research: "research",
  "rag-question-answering": "precise",
  summarization: "precise",
  "structured-extraction": "technical",
  "data-analysis": "technical",
  "code-generation": "technical",
  "code-debugging": "technical",
  "code-architecture": "technical",
  "writing-editing": "fast",
  "creative-writing": "creative",
  "decision-support": "precise",
  "agentic-tool-use": "agentic",
  "prompt-optimization": "technical",
  "safety-critical": "safety-critical",
};

function recommendProfile(classification: Classification): PromptEnhancementProfileId {
  if (classification.criticality === "critical") return "safety-critical";
  return PROFILE_BY_TASK_CLASS[classification.taskClass];
}

// ─── Signal collection (explainability) ──────────────────────────────────────────
function collectSignals(
  classification: Classification,
  grounding: GroundingNeed,
  outputSchema: OutputSchemaDescriptor,
  missingContext: readonly ClarificationOrAssumption[],
): readonly PromptClassificationSignal[] {
  const signals: PromptClassificationSignal[] = [
    { dimension: "task-class", code: `class:${classification.taskClass}` },
    { dimension: "domain", code: `domain:${classification.domain}` },
    { dimension: "grounding", code: `grounding:${grounding.kind}` },
    { dimension: "output", code: `format:${outputSchema.format}` },
  ];
  for (const signal of grounding.signals)
    signals.push({ dimension: "grounding", code: `signal:${signal}` });
  for (const hint of outputSchema.hints)
    signals.push({ dimension: "output", code: `hint:${hint}` });
  for (const flag of classification.riskFlags)
    signals.push({ dimension: "risk", code: `risk:${flag}` });
  for (const item of missingContext)
    signals.push({ dimension: "missing-context", code: `topic:${item.topic}` });
  return signals;
}

// ─── Public entry point ──────────────────────────────────────────────────────────
/**
 * Convert a raw prompt-enhancement request into a deterministic, normalized `PromptTaskAnalysis`.
 * Pure: identical requests always produce identical analyses. No model call, IO, clock, or random.
 */
export function analyzePrompt(request: PromptEnhancementRequest): PromptTaskAnalysis {
  const normalized = normalizePromptDraft(request.input.text);
  const view = buildView(normalized, request);
  const classification = classify(view);
  const grounding = detectGroundingNeed(view, classification.taskClass);
  const outputSchema = detectOutputSchema(view.lower, classification.taskClass);
  const topics = detectMissingTopics(view, classification, outputSchema);
  const missingContext = toMissingContext(topics, request.missingInformationStrategy);
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: request.requestId,
    taskClass: classification.taskClass,
    taskClassConfidence: classification.confidence,
    domain: classification.domain,
    criticality: classification.criticality,
    groundingNeed: grounding,
    outputSchema,
    missingContext,
    riskFlags: classification.riskFlags,
    recommendedProfile: recommendProfile(classification),
    normalizedInputLength: view.normalizedLength,
    signals: collectSignals(classification, grounding, outputSchema, missingContext),
  };
}

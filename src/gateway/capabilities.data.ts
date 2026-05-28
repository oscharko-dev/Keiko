// Raw capability registry data for the nine Wave 1 models. All numeric and class
// values are documented assumptions based on public model cards and provider
// documentation as of 2026-05-28; [assumption] marks figures the customer may
// override via config when authoritative deployment numbers are available.

import type { ModelCapability } from "./types.js";

export const CAPABILITY_DATA: readonly ModelCapability[] = [
  {
    id: "Qwen3-Coder-480B-A35B-Instruct-FP8",
    kind: "chat",
    contextWindow: 128_000, // [assumption]
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "high",
    latencyClass: "slow",
    throughputHint: "~40 tok/s [assumption]",
    preferredUseCases: ["Large-codebase refactor", "Cross-file analysis"],
    knownLimitations: ["Very high VRAM; slow for interactive use"],
  },
  {
    id: "Qwen/Qwen3-Coder-Next-FP8",
    kind: "chat",
    contextWindow: 128_000, // [assumption]
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "high",
    latencyClass: "slow",
    throughputHint: "~40 tok/s [assumption]",
    preferredUseCases: ["Deep code synthesis requiring maximum reasoning depth"],
    knownLimitations: [
      "Same VRAM/latency constraints as Qwen3-Coder-480B; treat as next-generation upgrade path",
    ],
  },
  {
    id: "Devstral-2-123B-Instruct-2512",
    kind: "chat",
    contextWindow: 128_000, // [assumption]
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "high",
    latencyClass: "standard",
    throughputHint: "~80 tok/s [assumption]",
    preferredUseCases: ["Agentic code completion", "Multi-step software engineering"],
    knownLimitations: [
      "123B scale; requires dedicated GPU allocation; not suitable for high-QPS workloads",
    ],
  },
  {
    id: "gpt-oss-120b",
    kind: "chat",
    contextWindow: 128_000, // [assumption]
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "high",
    latencyClass: "standard",
    throughputHint: "~80 tok/s [assumption]",
    preferredUseCases: ["General-purpose coding", "Code review", "Explanation"],
    knownLimitations: [
      "Customer-hosted OSS model; endpoint reliability depends on customer infrastructure",
    ],
  },
  {
    id: "Mistral-Small-3.1-24B-Instruct-2503",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "medium",
    latencyClass: "fast",
    throughputHint: "~150 tok/s [assumption]",
    preferredUseCases: ["Interactive code assist", "Quick edits", "Low-latency agent steps"],
    knownLimitations: ["Smaller model; may require multi-turn for complex reasoning"],
  },
  {
    id: "Qwen2.5-Coder-7B-Instruct",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096, // [assumption]
    toolCalling: true,
    structuredOutput: false, // [assumption]
    streaming: true,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "~200 tok/s [assumption]",
    preferredUseCases: [
      "Inline completion",
      "Snippet generation",
      "High-throughput batch coding tasks",
    ],
    knownLimitations: [
      "Limited structured-output reliability; context degradation beyond 64K tokens observed in benchmarks [assumption]",
    ],
  },
  {
    id: "gemma-4-31b-it",
    kind: "chat",
    contextWindow: 128_000, // [assumption]
    maxOutputTokens: 8_192, // [assumption]
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "~120 tok/s [assumption]",
    preferredUseCases: ["Document summarisation", "Code explanation", "Regulated-context Q&A"],
    knownLimitations: [
      "Instruction-tuned variant; verify function-calling reliability against customer endpoint",
    ],
  },
  {
    id: "dotsocr",
    kind: "ocr-vision",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "n/a",
    preferredUseCases: [
      "Document OCR",
      "Scanned contract/form extraction",
      "Image-to-text in regulated workflows",
    ],
    knownLimitations: [
      "Not a chat model; chat-completions adapter does not apply; callOcr method is Wave 2",
    ],
  },
  {
    id: "multilingual-e5-large Embedding",
    kind: "embedding",
    contextWindow: 512, // [assumption]
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "n/a",
    preferredUseCases: [
      "Semantic search",
      "RAG retrieval",
      "Similarity ranking across multilingual content",
    ],
    knownLimitations: ["Max 512 tokens per input; callEmbedding method is Wave 2"],
  },
];

import { describe, expect, it } from "vitest";
import {
  MAX_GATEWAY_CONFIG_BYTES,
  appliedGatewayConfigFieldCount,
  parseGatewayConfigUpload,
  type GatewayConfigUploadFields,
} from "./gatewayConfigParsing";

function providerFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: "gpt-5o",
    baseUrl: "https://llm-gateway.example.com/v1",
    apiKeyHeaderName: "api-key",
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 500,
    capability: {
      id: "gpt-5o",
      kind: "chat",
      supportsImageInput: true,
      workflowEligible: true,
    },
    ...overrides,
  };
}

function voiceProviderFixture(
  modelId: string,
  capabilityOverrides: Record<string, unknown>,
  providerOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    modelId,
    baseUrl: "https://voice.example.com",
    apiKeyHeaderName: "api-key",
    timeoutMs: 120_000,
    // The canonical parser requires voiceProviderLocality on every voice capability
    // (resolveVoiceKindFields) — the fixture mirrors a file the product can actually load;
    // the absent-locality refusal pin overrides it away explicitly (#3037).
    capability: {
      id: modelId,
      kind: "voice",
      voiceProviderLocality: "azure-foundry",
      ...capabilityOverrides,
    },
    ...providerOverrides,
  };
}

/** The voice fields of a file that carries no voice provider at all. */
const NO_VOICE_FIELDS = {
  voiceBaseUrl: undefined,
  voiceApiKey: undefined,
  voiceApiKeyHeaderName: undefined,
  voiceTimeoutMs: undefined,
  voiceModelId: undefined,
  voiceSpeechOutputModelId: undefined,
  voiceRealtimeModelId: undefined,
  voiceRealtimeTranscriptionModelId: undefined,
  voiceSemanticTurnDetection: undefined,
  voiceOutputVoiceId: undefined,
  voiceProfilesReduced: false,
  voiceProviderLocality: undefined,
  voiceSupportsSpeechSynthesisInstructions: undefined,
  voiceRealtimeSkipped: false,
  voiceRetryTuningReset: false,
} as const;

function fieldsOf(serialized: string): GatewayConfigUploadFields {
  const result = parseGatewayConfigUpload(serialized);
  if (result.outcome !== "fields") throw new Error(`expected fields, got ${result.outcome}`);
  return result.fields;
}

describe("parseGatewayConfigUpload", () => {
  it("maps the documented keiko.config.json shape onto the form fields", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          providerFixture({
            modelId: "text-embed",
            capability: { id: "text-embed", kind: "embedding" },
          }),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
    );

    expect(fields).toEqual({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: undefined,
      apiKeyHeaderName: "api-key",
      timeoutMs: "30000",
      deploymentNames: ["gpt-5o", "text-embed"],
      imageInputModelIds: ["gpt-5o"],
      workflowEligibleModelIds: ["gpt-5o"],
      embeddingModelIds: ["text-embed"],
      figmaAccessToken: undefined,
      ...NO_VOICE_FIELDS,
    });
  });

  it("loads the persisted product configuration shape: chat, embedding, and voice together", () => {
    // THE file this feature exists for: the owner's persisted keiko.config.json — two chat
    // models, one embedding, an STT/TTS pair on a dedicated speech endpoint, and a realtime
    // provider sharing the gateway endpoint (sequential voice updates produce exactly this).
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({ timeoutMs: 120_000 }),
          providerFixture({
            modelId: "large-chat",
            timeoutMs: 120_000,
            capability: { id: "large-chat", kind: "chat" },
          }),
          providerFixture({
            modelId: "text-embed",
            timeoutMs: 120_000,
            capability: { id: "text-embed", kind: "embedding" },
          }),
          voiceProviderFixture(
            "keiko-stt",
            { supportsSpeechInput: true },
            { endpointStyle: "azure-openai-deployment", apiVersion: "2025-03-01-preview" },
          ),
          voiceProviderFixture(
            "keiko-tts",
            { supportsSpeechOutput: true },
            {
              endpointStyle: "azure-openai-deployment",
              apiVersion: "2025-03-01-preview",
              voiceProfiles: [
                { persona: "male", voiceId: "alloy" },
                { persona: "female", voiceId: "nova" },
                { persona: "neutral", voiceId: "alloy" },
              ],
            },
          ),
          voiceProviderFixture(
            "keiko-realtime",
            {
              supportsSpeechInput: true,
              supportsSpeechOutput: true,
              supportsRealtimeVoice: true,
              supportsSemanticTurnDetection: true,
              realtimeTranscriptionModel: "keiko-realtime-stt",
            },
            {
              baseUrl: "https://llm-gateway.example.com/v1",
              realtimeAuthMode: "ephemeral-session",
            },
          ),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
    );

    expect(fields).toEqual({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: undefined,
      apiKeyHeaderName: "api-key",
      timeoutMs: "120000",
      deploymentNames: ["gpt-5o", "large-chat", "text-embed"],
      imageInputModelIds: ["gpt-5o"],
      workflowEligibleModelIds: ["gpt-5o"],
      embeddingModelIds: ["text-embed"],
      figmaAccessToken: undefined,
      voiceBaseUrl: "https://voice.example.com",
      voiceApiKey: undefined,
      voiceApiKeyHeaderName: "api-key",
      voiceTimeoutMs: "120000",
      voiceModelId: "keiko-stt",
      voiceSpeechOutputModelId: "keiko-tts",
      // The speech pair's Azure deployment protocol imports verbatim; the SKIPPED realtime
      // provider's realtimeAuthMode must not ride along (#3037).
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-03-01-preview",
      voiceRealtimeAuthMode: undefined,
      // The realtime provider lives on a different connection than the speech pair; one submit
      // holds one voice connection, so it is skipped LOUDLY, never silently.
      voiceRealtimeModelId: undefined,
      voiceRealtimeTranscriptionModelId: undefined,
      voiceSemanticTurnDetection: undefined,
      voiceSupportsSpeechSynthesisInstructions: false,
      // Three profiles carrying two voices reduce to the neutral persona's, stated.
      voiceOutputVoiceId: "alloy",
      voiceProfilesReduced: true,
      voiceProviderLocality: "azure-foundry",
      voiceRealtimeSkipped: true,
      voiceRetryTuningReset: false,
    });
    expect(appliedGatewayConfigFieldCount(fields)).toBe(13);
  });

  it("imports all three voice roles when they share one connection", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-stt", { supportsSpeechInput: true }),
          voiceProviderFixture("keiko-tts", { supportsSpeechOutput: true }),
          voiceProviderFixture("keiko-realtime", {
            supportsRealtimeVoice: true,
            supportsSemanticTurnDetection: true,
            realtimeTranscriptionModel: "keiko-realtime-stt",
          }),
        ],
      }),
    );

    expect(fields.voiceModelId).toBe("keiko-stt");
    expect(fields.voiceSpeechOutputModelId).toBe("keiko-tts");
    expect(fields.voiceRealtimeModelId).toBe("keiko-realtime");
    expect(fields.voiceRealtimeTranscriptionModelId).toBe("keiko-realtime-stt");
    expect(fields.voiceSemanticTurnDetection).toBe(true);
    expect(fields.voiceRealtimeSkipped).toBe(false);
  });

  it("imports a realtime-only voice section on its own connection", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-realtime", {
            supportsRealtimeVoice: true,
            realtimeTranscriptionModel: "keiko-realtime-stt",
          }),
        ],
      }),
    );

    expect(fields.voiceBaseUrl).toBe("https://voice.example.com");
    expect(fields.voiceRealtimeModelId).toBe("keiko-realtime");
    expect(fields.voiceRealtimeSkipped).toBe(false);
  });

  it("passes an optional per-provider apiKey through for prefill", () => {
    const fields = fieldsOf(
      JSON.stringify({ providers: [providerFixture({ apiKey: "placeholder-secret" })] }),
    );

    expect(fields.apiKey).toBe("placeholder-secret");
  });

  it("rejects providers that disagree on any connection scalar instead of flattening them", () => {
    // Review finding on #3031: the form holds one connection; testing every model against the
    // first provider's endpoint would silently rewrite the others.
    const conflicting = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({
          modelId: "other",
          baseUrl: "https://different.example.com/v1",
          capability: undefined,
        }),
      ],
    });

    expect(parseGatewayConfigUpload(conflicting)).toEqual({ outcome: "invalid" });
  });

  it("rejects a mix of a stated connection scalar and an omitted one", () => {
    // Review finding on #3031: applying one provider's stated value to a provider that omitted
    // it would silently rewrite the second provider's connection.
    const mixed = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({ modelId: "other", baseUrl: undefined, capability: undefined }),
      ],
    });

    expect(parseGatewayConfigUpload(mixed)).toEqual({ outcome: "invalid" });
  });

  it("accepts supported header names case-insensitively", () => {
    // The gateway normalizes header names to lower case — "API-Key" is the same supported
    // header, not an unsupported one (review finding on #3031).
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture({ apiKeyHeaderName: "API-Key", capability: undefined })],
      }),
    );

    expect(fields.apiKeyHeaderName).toBe("API-Key");
  });

  it("treats identical repeated scalars as one connection", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          providerFixture({ modelId: "second", capability: undefined }),
        ],
      }),
    );

    expect(fields.baseUrl).toBe("https://llm-gateway.example.com/v1");
    expect(fields.deploymentNames).toEqual(["gpt-5o", "second"]);
  });

  it("applies an explicitly empty eligibility declaration as an empty list, not silence", () => {
    // Review finding on #3031: a file whose capabilities declare NO eligible model must clear
    // the form field, exactly like manually emptying it.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({
            capability: { id: "gpt-5o", kind: "chat", workflowEligible: false },
          }),
        ],
      }),
    );

    expect(fields.workflowEligibleModelIds).toEqual([]);
    expect(fields.imageInputModelIds).toEqual([]);
  });

  it("leaves the flag lists undefined when the file carries no capability record at all", () => {
    const fields = fieldsOf(
      JSON.stringify({ providers: [{ modelId: "gpt-5o", baseUrl: "https://x.example.com" }] }),
    );

    expect(fields.workflowEligibleModelIds).toBeUndefined();
    expect(fields.imageInputModelIds).toBeUndefined();
  });

  it("lets an authoritative top-level capability override an inline declaration", () => {
    // Review finding on #3031: production configuration parsing resolves capabilities by model
    // id with top-level records overriding inline ones — the importer must agree.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture()],
        capabilities: [
          { id: "gpt-5o", kind: "chat", supportsImageInput: false, workflowEligible: false },
        ],
      }),
    );

    expect(fields.workflowEligibleModelIds).toEqual([]);
    expect(fields.imageInputModelIds).toEqual([]);
  });

  it("refuses cross-kind TRUE flags and derives the flag lists from chat capabilities", () => {
    // Review findings on #3031 (superseding the earlier ignore-behavior): a flag may only be
    // TRUE on the kind that owns it — the canonical parser rejects an embedding claiming image
    // or workflow support, and setup would silently rewrite it on save.
    const crossKind = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({
          modelId: "text-embed",
          capability: {
            id: "text-embed",
            kind: "embedding",
            supportsImageInput: true,
            workflowEligible: true,
          },
        }),
      ],
    });
    expect(parseGatewayConfigUpload(crossKind)).toEqual({ outcome: "invalid" });

    // Explicit FALSE stays tolerated on every kind — the persisted product configuration
    // writes it — and the flag lists still derive from chat capabilities alone.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          providerFixture({
            modelId: "text-embed",
            capability: {
              id: "text-embed",
              kind: "embedding",
              supportsImageInput: false,
              workflowEligible: false,
            },
          }),
        ],
      }),
    );
    expect(fields.imageInputModelIds).toEqual(["gpt-5o"]);
    expect(fields.workflowEligibleModelIds).toEqual(["gpt-5o"]);
  });

  it("keeps the flag lists silent when no chat capability speaks", () => {
    // Review finding on #3031: an embedding-only declaration made speaksAboutFlags true and
    // cleared stored chat image/workflow flags the file never mentioned.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({ capability: undefined }),
          providerFixture({
            modelId: "text-embed",
            capability: { id: "text-embed", kind: "embedding" },
          }),
        ],
      }),
    );

    expect(fields.imageInputModelIds).toBeUndefined();
    expect(fields.workflowEligibleModelIds).toBeUndefined();
  });

  it("refuses a chat capability claiming a voice role", () => {
    const speakingChat = JSON.stringify({
      providers: [
        providerFixture({
          capability: { id: "gpt-5o", kind: "chat", supportsSpeechInput: true },
        }),
      ],
    });

    expect(parseGatewayConfigUpload(speakingChat)).toEqual({ outcome: "invalid" });
  });

  it("refuses OCR providers the setup form cannot represent", () => {
    // Review finding on #3031: no setup field exists for ocr-vision; importing it as a generic
    // deployment would persist the wrong capability kind.
    const ocr = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({ modelId: "ocr", capability: { id: "ocr", kind: "ocr-vision" } }),
      ],
    });

    expect(parseGatewayConfigUpload(ocr)).toEqual({ outcome: "unsupportedKind" });
  });

  it("derives the output voice from uniform profiles without a reduction", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture(
            "keiko-tts",
            { supportsSpeechOutput: true },
            { voiceProfiles: [{ persona: "neutral", voiceId: "nova" }] },
          ),
        ],
      }),
    );

    expect(fields.voiceOutputVoiceId).toBe("nova");
    expect(fields.voiceProfilesReduced).toBe(false);
  });

  it("refuses a voice connection whose providers disagree on the endpoint protocol", () => {
    // One submit carries ONE protocol per voice connection; importing would silently rewrite
    // the provider that declared the other shape (#3037).
    const mixed = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-stt",
          { supportsSpeechInput: true },
          { endpointStyle: "azure-openai-deployment", apiVersion: "2025-03-01-preview" },
        ),
        voiceProviderFixture("keiko-tts", { supportsSpeechOutput: true }),
      ],
    });

    expect(parseGatewayConfigUpload(mixed)).toEqual({ outcome: "invalid" });
  });

  it("refuses an endpoint style the gateway does not speak", () => {
    const unknownStyle = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-stt",
          { supportsSpeechInput: true },
          { endpointStyle: "soap-rpc" },
        ),
      ],
    });

    expect(parseGatewayConfigUpload(unknownStyle)).toEqual({ outcome: "invalid" });
  });

  it("refuses an api version the gateway's format rule rejects", () => {
    // Mirrors resolveProviderApiVersion (YYYY-MM-DD or YYYY-MM-DD-preview): accepting a
    // malformed version would turn the reported upload success into a guaranteed Test & Save
    // failure (#3037).
    const malformed = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-stt",
          { supportsSpeechInput: true },
          { endpointStyle: "azure-openai-deployment", apiVersion: "not-a-date" },
        ),
      ],
    });

    expect(parseGatewayConfigUpload(malformed)).toEqual({ outcome: "invalid" });
  });

  it("states the retry-tuning reset for an imported voice provider, loudly", () => {
    // The persisted product configuration carries per-role voice retry tuning (the owner's file
    // has maxRetries 3 on TTS) that the flat form cannot express — the import applies with the
    // reset STATED, never silently and never as a refusal that would lose the file (#3037).
    const tuned = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-stt", { supportsSpeechInput: true }, { maxRetries: 3 }),
        ],
      }),
    );
    expect(tuned.voiceRetryTuningReset).toBe(true);

    const defaults = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture(
            "keiko-stt",
            { supportsSpeechInput: true },
            { maxRetries: 1, retryBaseDelayMs: 500 },
          ),
        ],
      }),
    );
    expect(defaults.voiceRetryTuningReset).toBe(false);
  });

  it("refuses an api version outside the Azure deployment shape", () => {
    // The canonical parser binds apiVersion to endpointStyle "azure-openai-deployment"; a file
    // violating that pairing is one the product itself refuses to load.
    const orphanVersion = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-stt",
          { supportsSpeechInput: true },
          { apiVersion: "2025-03-01-preview" },
        ),
      ],
    });

    expect(parseGatewayConfigUpload(orphanVersion)).toEqual({ outcome: "invalid" });
  });

  it("refuses base URLs the canonical parser cannot accept", () => {
    // Mirrors validateBaseUrl (review finding on #3037): absolute http(s) only, plaintext http
    // only for loopback — a malformed or off-loopback-http URL would fail Test & Save after a
    // reported upload success.
    for (const badUrl of [
      "not a URL",
      "http://litellm.internal/v1",
      "https://x.example/v1?q=1",
      "https://user:pass@x.example/v1",
      "https://x.example/v1#frag",
    ]) {
      const refused = JSON.stringify({ providers: [providerFixture({ baseUrl: badUrl })] });
      expect(parseGatewayConfigUpload(refused)).toEqual({ outcome: "invalid" });
    }
    for (const goodUrl of ["http://127.0.0.1:4000/v1", "http://127.255.255.255/v1"]) {
      const loopback = fieldsOf(
        JSON.stringify({ providers: [providerFixture({ baseUrl: goodUrl })] }),
      );
      expect(loopback.baseUrl).toBe(goodUrl);
    }
  });

  it("refuses a provider carrying a secret reference the form cannot apply", () => {
    // The token field takes a plaintext key; silently dropping apiKeySecretRef would strand the
    // provider's only credential source (#3037). The product's own persisted file never carries
    // the field — its credentials live in the sealed vault outside the JSON.
    const withRef = JSON.stringify({
      providers: [providerFixture({ apiKeySecretRef: "vault:main-token" })],
    });
    expect(parseGatewayConfigUpload(withRef)).toEqual({ outcome: "unsupportedSetting" });
  });

  it("rejects a voice locality on a non-voice capability", () => {
    // The canonical parser rejects a chat/embedding capability carrying voiceProviderLocality
    // (assertNoVoiceFieldsForNonVoiceKind) — reporting upload success would hand the route a
    // file it refuses, silently discarding the field (#3037).
    const misplaced = JSON.stringify({
      providers: [
        providerFixture({
          capability: { id: "gpt-5o", kind: "chat", voiceProviderLocality: "azure-foundry" },
        }),
      ],
    });

    expect(parseGatewayConfigUpload(misplaced)).toEqual({ outcome: "invalid" });
  });

  it("rejects voice profiles on a realtime-only provider", () => {
    // The canonical gateway parser requires supportsSpeechOutput for a voiceProfiles block; a
    // realtime-only carrier is a configuration the product rejects, so reporting upload success
    // for it would hand the user a file the route cannot save (#3037).
    const realtimeOnly = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-realtime",
          { supportsRealtimeVoice: true },
          { voiceProfiles: [{ persona: "neutral", voiceId: "ash" }] },
        ),
      ],
    });

    expect(parseGatewayConfigUpload(realtimeOnly)).toEqual({ outcome: "invalid" });
  });

  it("fills unclaimed speech roles from a multi-role realtime provider", () => {
    // Review finding on #3031: the setup route merges roles sharing one model id — excluding a
    // realtime provider from the speech roles it advertises would silently remove Dictate and
    // Read-aloud support on save.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture(
            "keiko-realtime",
            {
              supportsSpeechInput: true,
              supportsSpeechOutput: true,
              supportsRealtimeVoice: true,
              realtimeTranscriptionModel: "keiko-realtime-stt",
            },
            { voiceProfiles: [{ persona: "neutral", voiceId: "ash" }] },
          ),
        ],
      }),
    );

    expect(fields.voiceModelId).toBe("keiko-realtime");
    expect(fields.voiceSpeechOutputModelId).toBe("keiko-realtime");
    expect(fields.voiceRealtimeModelId).toBe("keiko-realtime");
    expect(fields.voiceOutputVoiceId).toBe("ash");
  });

  it("never fills speech roles from a SKIPPED realtime provider", () => {
    // The skipped realtime lives on a different connection — its speech flags must not leak
    // into fields that submit against the imported voice connection.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-stt", { supportsSpeechInput: true }),
          voiceProviderFixture(
            "keiko-realtime",
            { supportsSpeechOutput: true, supportsRealtimeVoice: true },
            { baseUrl: "https://llm-gateway.example.com/v1" },
          ),
        ],
      }),
    );

    expect(fields.voiceRealtimeSkipped).toBe(true);
    expect(fields.voiceSpeechOutputModelId).toBeUndefined();
    expect(fields.voiceModelId).toBe("keiko-stt");
  });

  it("carries a uniform non-default voice locality into the form", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-stt", {
            supportsSpeechInput: true,
            voiceProviderLocality: "customer-hosted",
          }),
        ],
      }),
    );

    expect(fields.voiceProviderLocality).toBe("customer-hosted");
  });

  it("refuses voice providers that disagree on locality", () => {
    const split = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("keiko-stt", {
          supportsSpeechInput: true,
          voiceProviderLocality: "customer-hosted",
        }),
        // The fixture's default locality (azure-foundry) — a DIFFERENT locality than above.
        voiceProviderFixture("keiko-tts", { supportsSpeechOutput: true }),
      ],
    });

    expect(parseGatewayConfigUpload(split)).toEqual({ outcome: "invalid" });
  });

  it("carries speech-synthesis instruction support from an uploaded TTS capability", () => {
    // Review finding on #3037: supportsSpeechSynthesisInstructions is a behavior-bearing
    // canonical voice flag — the parser neither validated nor captured it, so the upload
    // reported success and the rebuilt capability silently lost instruction support.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-tts", {
            supportsSpeechOutput: true,
            supportsSpeechSynthesisInstructions: true,
          }),
        ],
      }),
    );

    expect(fields.voiceSupportsSpeechSynthesisInstructions).toBe(true);
  });

  it("rejects synthesis instructions without speech output", () => {
    // Canonical rule: supportsSpeechSynthesisInstructions requires supportsSpeechOutput.
    const sttOnly = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("keiko-stt", {
          supportsSpeechInput: true,
          supportsSpeechSynthesisInstructions: true,
        }),
      ],
    });

    expect(parseGatewayConfigUpload(sttOnly)).toEqual({ outcome: "invalid" });
  });

  it("rejects synthesis instructions on a non-voice capability", () => {
    const misplaced = JSON.stringify({
      providers: [
        providerFixture({
          capability: { id: "gpt-5o", kind: "chat", supportsSpeechSynthesisInstructions: true },
        }),
      ],
    });

    expect(parseGatewayConfigUpload(misplaced)).toEqual({ outcome: "invalid" });
  });

  it("refuses a voice section whose connection has no base URL", () => {
    // KfQ finding on #3037: a voice provider without baseUrl parsed into role ids with
    // voiceBaseUrl undefined — the dialog's file-scoped replacement semantics key on
    // voiceBaseUrl, so the roles would apply while the voice section counted as absent. The
    // canonical parser requires baseUrl on every provider and the product's sealed file always
    // carries it; a voice section without a connectable endpoint is corrupted input.
    const noUrl = JSON.stringify({
      providers: [
        providerFixture(),
        {
          modelId: "keiko-stt",
          apiKeyHeaderName: "api-key",
          capability: {
            id: "keiko-stt",
            kind: "voice",
            supportsSpeechInput: true,
            voiceProviderLocality: "azure-foundry",
          },
        },
      ],
    });

    expect(parseGatewayConfigUpload(noUrl)).toEqual({ outcome: "invalid" });
  });

  it("refuses a voice capability that declares no locality", () => {
    // The canonical parser requires voiceProviderLocality on every voice capability
    // (resolveVoiceKindFields) — substituting the production default would silently rewrite a
    // file the product itself refuses to load (#3037).
    const missingLocality = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("keiko-stt", {
          supportsSpeechInput: true,
          voiceProviderLocality: undefined,
        }),
      ],
    });

    expect(parseGatewayConfigUpload(missingLocality)).toEqual({ outcome: "invalid" });
  });

  it("refuses a transcription model on a voice capability without realtime support", () => {
    // The canonical parser rejects realtimeTranscriptionModel unless supportsRealtimeVoice is
    // true (assertVoiceTuningInvariants) — accepting it here would report success and then
    // silently drop the transcription model, because only a realtime provider carries it into
    // the form fields (#3037).
    const speechOnly = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("keiko-stt", {
          supportsSpeechInput: true,
          realtimeTranscriptionModel: "keiko-realtime-stt",
        }),
      ],
    });

    expect(parseGatewayConfigUpload(speechOnly)).toEqual({ outcome: "invalid" });
  });

  it("tolerates the exact circuit breaker the setup route rebuilds and refuses a tuned one", () => {
    // Review finding on #3031: the route rebuilds {5, 30000, 2}; different values would be
    // silently replaced behind a success message.
    const matching = JSON.stringify({
      providers: [providerFixture()],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    });
    expect(parseGatewayConfigUpload(matching).outcome).toBe("fields");

    const tuned = JSON.stringify({
      providers: [providerFixture()],
      circuitBreaker: { failureThreshold: 9, cooldownMs: 30_000, halfOpenProbes: 2 },
    });
    expect(parseGatewayConfigUpload(tuned)).toEqual({ outcome: "unsupportedSetting" });

    const extra = JSON.stringify({
      providers: [providerFixture()],
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMs: 30_000,
        halfOpenProbes: 2,
        surprise: true,
      },
    });
    expect(parseGatewayConfigUpload(extra)).toEqual({ outcome: "unsupportedSetting" });

    // An inherited prototype name must count as an extra key too (review finding on #3031).
    const prototypeKey = JSON.stringify({
      providers: [providerFixture()],
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMs: 30_000,
        halfOpenProbes: 2,
        toString: "sneaky",
      },
    });
    expect(parseGatewayConfigUpload(prototypeKey)).toEqual({ outcome: "unsupportedSetting" });

    // Omitted keys mean the rebuilt defaults — a partial block that only restates them imports.
    const partial = JSON.stringify({
      providers: [providerFixture()],
      circuitBreaker: { failureThreshold: 5 },
    });
    expect(parseGatewayConfigUpload(partial).outcome).toBe("fields");
  });

  it("refuses two providers claiming the same voice role", () => {
    const duplicated = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("stt-one", { supportsSpeechInput: true }),
        voiceProviderFixture("stt-two", { supportsSpeechInput: true }),
      ],
    });

    expect(parseGatewayConfigUpload(duplicated)).toEqual({ outcome: "invalid" });
  });

  it("refuses a voice provider that declares no role at all", () => {
    const roleless = JSON.stringify({
      providers: [providerFixture(), voiceProviderFixture("mystery-voice", {})],
    });

    expect(parseGatewayConfigUpload(roleless)).toEqual({ outcome: "invalid" });
  });

  it("refuses speech providers that disagree on their connection", () => {
    const split = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture("keiko-stt", { supportsSpeechInput: true }),
        voiceProviderFixture(
          "keiko-tts",
          { supportsSpeechOutput: true },
          { baseUrl: "https://other-voice.example.com" },
        ),
      ],
    });

    expect(parseGatewayConfigUpload(split)).toEqual({ outcome: "invalid" });
  });

  it("carries a supported Figma credential through for prefill", () => {
    // Review finding on #3031: the setup form owns a Figma token field, so a file that carries
    // one must fill it instead of silently dropping the connector credential.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture()],
        figma: { accessToken: "figma-placeholder-token" },
      }),
    );

    expect(fields.figmaAccessToken).toBe("figma-placeholder-token");
    expect(appliedGatewayConfigFieldCount(fields)).toBe(7);
  });

  it("rejects a malformed top-level capability record instead of skipping it", () => {
    // Review finding on #3031: the same fail-closed policy as the provider list — hostile or
    // corrupted capability entries must not be silently dropped from a "successful" load.
    const malformed = JSON.stringify({
      providers: [providerFixture()],
      capabilities: ["not-an-object"],
    });

    expect(parseGatewayConfigUpload(malformed)).toEqual({ outcome: "invalid" });
  });

  it("rejects a top-level capability whose id no imported provider carries", () => {
    // Review finding on #3031: an untestable id in the flag lists would fail Test & Save AFTER
    // the upload reported success.
    const orphan = JSON.stringify({
      providers: [providerFixture()],
      capabilities: [{ id: "vision-x", kind: "chat", supportsImageInput: true }],
    });

    expect(parseGatewayConfigUpload(orphan)).toEqual({ outcome: "invalid" });
  });

  it("tolerates capability metadata fields the form does not read", () => {
    // The persisted product configuration carries context windows, cost classes, and hints —
    // they must not fail the strict flag validation.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture()],
        capabilities: [
          {
            id: "gpt-5o",
            kind: "chat",
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
            toolCalling: true,
            costClass: "low",
            supportsImageInput: true,
            workflowEligible: true,
          },
        ],
      }),
    );

    expect(fields.imageInputModelIds).toEqual(["gpt-5o"]);
  });

  it("refuses an oversized payload before parsing it", () => {
    // Review finding on #3031: the upload control checks file.size, but the parser owns its own
    // ceiling so no future call site can feed an unbounded payload into JSON.parse.
    const oversized = `{"providers": [${" ".repeat(MAX_GATEWAY_CONFIG_BYTES)}]}`;

    expect(parseGatewayConfigUpload(oversized)).toEqual({ outcome: "invalid" });
  });

  it("measures the payload ceiling in bytes, not UTF-16 units", () => {
    // Review finding on #3031: "€" is one UTF-16 unit but three UTF-8 bytes, so a multi-byte
    // payload can stay under the string-length check while exceeding the byte ceiling.
    const units = Math.floor(MAX_GATEWAY_CONFIG_BYTES / 3) + 100;
    const multiByte = `{"providers": "${"€".repeat(units)}"}`;

    expect(multiByte.length).toBeLessThan(MAX_GATEWAY_CONFIG_BYTES);
    expect(parseGatewayConfigUpload(multiByte)).toEqual({ outcome: "invalid" });
  });

  it("mirrors the setup route's 100-provider ceiling at upload time", () => {
    // Review finding on #3031: an oversized file must fail here, not at Test & Save after a
    // reported success.
    const oversized = JSON.stringify({
      providers: Array.from({ length: 101 }, (_, index) =>
        providerFixture({ modelId: `model-${String(index)}`, capability: undefined }),
      ),
    });

    expect(parseGatewayConfigUpload(oversized)).toEqual({ outcome: "invalid" });
  });

  it("refuses top-level policy blocks the rebuild would silently drop", () => {
    // Review finding on #3031 (P1): grounding, reranker, and egress have no setup field — a
    // "successful" load followed by a save would persist the providers WITHOUT the uploaded
    // retrieval, reranking, or egress policy.
    for (const block of ["grounding", "reranker", "egress"]) {
      const carrying = JSON.stringify({ providers: [providerFixture()], [block]: {} });
      expect(parseGatewayConfigUpload(carrying)).toEqual({ outcome: "unsupportedSetting" });
    }
  });

  it("refuses generic provider settings the form cannot represent with an honest outcome", () => {
    // Review finding on #3031: endpoint style / API version / output token parameter on a chat
    // or embedding provider would be silently rebuilt with defaults — a changed runtime
    // configuration behind a success message. Voice providers are exempt: the voice setup route
    // regenerates their endpoint details itself.
    const azure = JSON.stringify({
      providers: [providerFixture({ endpointStyle: "azure-openai-deployment" })],
    });

    expect(parseGatewayConfigUpload(azure)).toEqual({ outcome: "unsupportedSetting" });
    // Retry tuning matching what the rebuild writes stays representable; a DIFFERENT value
    // would be silently rewritten on save and refuses instead (review finding on #3031).
    const matching = JSON.stringify({
      providers: [providerFixture({ maxRetries: 2, retryBaseDelayMs: 500 })],
    });
    expect(parseGatewayConfigUpload(matching).outcome).toBe("fields");
    const tunedRetries = JSON.stringify({ providers: [providerFixture({ maxRetries: 7 })] });
    expect(parseGatewayConfigUpload(tunedRetries)).toEqual({ outcome: "unsupportedSetting" });
    // Voice providers keep their stored tuning through the voice route — exempt.
    const voiceTuned = JSON.stringify({
      providers: [
        providerFixture(),
        voiceProviderFixture(
          "keiko-stt",
          { supportsSpeechInput: true },
          { maxRetries: 1, retryBaseDelayMs: 500 },
        ),
      ],
    });
    expect(parseGatewayConfigUpload(voiceTuned).outcome).toBe("fields");
  });

  it.each([
    ["not JSON at all", "{ nope"],
    ["a JSON scalar", JSON.stringify("hello")],
    ["a JSON array root", JSON.stringify([])],
    ["an object without providers", JSON.stringify({ circuitBreaker: {} })],
    ["an empty providers array", JSON.stringify({ providers: [] })],
    ["a provider without a modelId", JSON.stringify({ providers: [{ baseUrl: "https://x" }] })],
    [
      "a provider list with one malformed entry (fail closed, no partial apply)",
      JSON.stringify({ providers: [providerFixture(), { modelId: 42 }] }),
    ],
    [
      "an unknown capability kind",
      JSON.stringify({
        providers: [providerFixture({ capability: { id: "gpt-5o", kind: "quantum" } })],
      }),
    ],
    [
      "a capability without a kind",
      JSON.stringify({
        providers: [providerFixture({ capability: { id: "gpt-5o", supportsImageInput: true } })],
      }),
    ],
    [
      "a non-boolean capability flag",
      JSON.stringify({
        providers: [
          providerFixture({
            capability: { id: "gpt-5o", kind: "chat", supportsImageInput: "yes" },
          }),
        ],
      }),
    ],
    [
      "a present-but-malformed inline capability",
      JSON.stringify({ providers: [providerFixture({ capability: "not-an-object" })] }),
    ],
    [
      "a non-string baseUrl",
      JSON.stringify({ providers: [providerFixture({ baseUrl: 42, capability: undefined })] }),
    ],
    [
      "a blank present baseUrl",
      JSON.stringify({ providers: [providerFixture({ baseUrl: "   ", capability: undefined })] }),
    ],
    [
      "a non-string header name",
      JSON.stringify({
        providers: [providerFixture({ apiKeyHeaderName: ["api-key"], capability: undefined })],
      }),
    ],
    [
      "a non-positive timeout",
      JSON.stringify({ providers: [providerFixture({ timeoutMs: -5, capability: undefined })] }),
    ],
    [
      "a non-string apiKey",
      JSON.stringify({
        providers: [providerFixture({ apiKey: { steal: true }, capability: undefined })],
      }),
    ],
    [
      "an oversized model id",
      JSON.stringify({
        providers: [providerFixture({ modelId: "m".repeat(161), capability: undefined })],
      }),
    ],
    [
      "a control-character model id",
      JSON.stringify({
        providers: [providerFixture({ modelId: "bad\u0000id", capability: undefined })],
      }),
    ],
    [
      "an inline capability whose id names a different model",
      JSON.stringify({
        providers: [providerFixture({ capability: { id: "other-model", kind: "chat" } })],
      }),
    ],
    [
      "a non-array voiceProfiles block",
      JSON.stringify({
        providers: [providerFixture({ voiceProfiles: "alloy", capability: undefined })],
      }),
    ],
    [
      "a voice profile without a voice id",
      JSON.stringify({
        providers: [
          providerFixture({ voiceProfiles: [{ persona: "neutral" }], capability: undefined }),
        ],
      }),
    ],
    [
      "an unknown voice locality",
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture("keiko-stt", {
            supportsSpeechInput: true,
            voiceProviderLocality: "on-the-moon",
          }),
        ],
      }),
    ],
    [
      "a present non-object figma block",
      JSON.stringify({ providers: [providerFixture()], figma: null }),
    ],
    [
      "a present non-object circuit breaker",
      JSON.stringify({ providers: [providerFixture()], circuitBreaker: "default" }),
    ],
    [
      "a duplicated top-level capability id",
      JSON.stringify({
        providers: [providerFixture()],
        capabilities: [
          { id: "gpt-5o", kind: "chat", supportsImageInput: true },
          { id: "gpt-5o", kind: "chat", supportsImageInput: false },
        ],
      }),
    ],
    [
      "an unsupported API key header name",
      JSON.stringify({
        providers: [providerFixture({ apiKeyHeaderName: "x-custom", capability: undefined })],
      }),
    ],
    [
      "semantic turn detection without realtime support",
      JSON.stringify({
        providers: [
          voiceProviderFixture("keiko-stt", {
            supportsSpeechInput: true,
            supportsSemanticTurnDetection: true,
          }),
          providerFixture(),
        ],
      }),
    ],
    [
      "voice profiles on a provider without an output role",
      JSON.stringify({
        providers: [
          providerFixture(),
          voiceProviderFixture(
            "keiko-stt",
            { supportsSpeechInput: true },
            { voiceProfiles: [{ persona: "neutral", voiceId: "alloy" }] },
          ),
        ],
      }),
    ],
    [
      "a voice-only configuration the setup form cannot save",
      JSON.stringify({
        providers: [voiceProviderFixture("keiko-stt", { supportsSpeechInput: true })],
      }),
    ],
    [
      "an unknown voice-profile persona",
      JSON.stringify({
        providers: [
          providerFixture({
            voiceProfiles: [{ persona: "robotic", voiceId: "alloy" }],
            capability: undefined,
          }),
        ],
      }),
    ],
    [
      "a duplicated voice-profile persona",
      JSON.stringify({
        providers: [
          providerFixture({
            voiceProfiles: [
              { persona: "neutral", voiceId: "alloy" },
              { persona: "neutral", voiceId: "nova" },
            ],
            capability: undefined,
          }),
        ],
      }),
    ],
  ])("refuses %s", (_label, serialized) => {
    // Review findings on #3031: a PRESENT but malformed value must refuse the file — converting
    // it to silence would report a hostile or corrupted file as successfully loaded, and an
    // unusable model id would fail Test & Save after a reported success.
    expect(parseGatewayConfigUpload(serialized)).toEqual({ outcome: "invalid" });
  });
});

describe("appliedGatewayConfigFieldCount", () => {
  it("counts filled scalars, deployments, and every defined flag list — empty included", () => {
    const fields = fieldsOf(JSON.stringify({ providers: [providerFixture()] }));

    // baseUrl + header + timeout + deployments + image list + workflow list; no apiKey on file.
    expect(appliedGatewayConfigFieldCount(fields)).toBe(6);

    const clearing = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({ capability: { id: "gpt-5o", kind: "chat", workflowEligible: false } }),
        ],
      }),
    );
    // The two defined-but-empty lists clear their fields — an applied change, so still 6.
    expect(appliedGatewayConfigFieldCount(clearing)).toBe(6);
  });
});

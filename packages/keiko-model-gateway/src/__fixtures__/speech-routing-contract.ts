import { expect, it } from "vitest";

/** The routing fields every speech adapter reads before it sends a request. */
export interface SpeechRoutingFields {
  readonly endpoint: string;
  readonly endpointStyle?: "azure-openai-deployment";
  readonly apiVersion?: string;
  readonly modelId: string;
}

export interface SpeechRoutingSubject {
  /** The adapter's request path below its endpoint, such as `/audio/speech`. */
  readonly path: string;
  /** An OpenAI-compatible endpoint for the adapter. */
  readonly endpoint: string;
  /**
   * Calls the adapter with `routing` (its own getters intact) plus the adapter's own payload,
   * through a fetch that reports each request URL to `onRequest` and answers healthily.
   */
  readonly request: (
    routing: SpeechRoutingFields,
    onRequest: (url: string) => void,
  ) => Promise<{ readonly ok: boolean }>;
}

function registerEncodedAzureRouting(subject: SpeechRoutingSubject): void {
  it.each([
    {
      modelId: "model /?#",
      apiVersion: "v1 &next=1",
      encodedModel: "model%20%2F%3F%23",
      encodedVersion: "v1%20%26next%3D1",
    },
    { modelId: "model%name", apiVersion: "", encodedModel: "model%25name", encodedVersion: "" },
    { modelId: "model", apiVersion: undefined, encodedModel: "model", encodedVersion: "" },
  ])(
    "encodes Azure speech routing components independently ($modelId)",
    async ({ modelId, apiVersion, encodedModel, encodedVersion }) => {
      let seenUrl = "";
      const outcome = await subject.request(
        {
          endpoint: "https://voice.example.invalid/base//",
          endpointStyle: "azure-openai-deployment",
          ...(apiVersion === undefined ? {} : { apiVersion }),
          modelId,
        },
        (url) => {
          seenUrl = url;
        },
      );
      expect(outcome.ok).toBe(true);
      expect(seenUrl).toBe(
        `https://voice.example.invalid/base//openai/deployments/${encodedModel}${subject.path}?api-version=${encodedVersion}`,
      );
    },
  );
}

function registerOpenAiRoutingWithoutVersion(subject: SpeechRoutingSubject): void {
  it("does not inspect apiVersion for OpenAI-compatible speech routing", async () => {
    let seenUrl = "";
    const outcome = await subject.request(
      {
        endpoint: subject.endpoint,
        get apiVersion(): string {
          throw new Error("OpenAI routing must not inspect the Azure version");
        },
        modelId: "model",
      },
      (url) => {
        seenUrl = url;
      },
    );
    expect(outcome.ok).toBe(true);
    expect(seenUrl).toBe(`${subject.endpoint}${subject.path}`);
  });
}

function registerAzureRoutingReadOrder(subject: SpeechRoutingSubject): void {
  it("reads Azure routing fields in their existing order before egress", async () => {
    const reads: string[] = [];
    let routingReads: string[] = [];
    const outcome = await subject.request(
      {
        get endpointStyle(): "azure-openai-deployment" {
          reads.push("style");
          return "azure-openai-deployment";
        },
        get endpoint(): string {
          reads.push("endpoint");
          return subject.endpoint;
        },
        get modelId(): string {
          reads.push("model");
          return "model";
        },
        get apiVersion(): string {
          reads.push("version");
          return "version";
        },
      },
      () => {
        routingReads = reads.slice(-4);
      },
    );
    expect(outcome.ok).toBe(true);
    expect(routingReads).toEqual(["style", "endpoint", "model", "version"]);
  });
}

/** Registers the routing cases speech-to-text and text-to-speech must share. */
export function registerSpeechRoutingContract(subject: SpeechRoutingSubject): void {
  registerEncodedAzureRouting(subject);
  registerOpenAiRoutingWithoutVersion(subject);
  registerAzureRoutingReadOrder(subject);
}

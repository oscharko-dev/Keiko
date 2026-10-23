import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { Response } = globalThis;
const moduleRoot =
  process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT ??
  fileURLToPath(new URL("./node_modules", import.meta.url));
const original = await import(pathToFileURL(join(moduleRoot, "@opencode/core/dist/mcp/oauth.js")));
const { auth } = await import(
  pathToFileURL(join(moduleRoot, "@modelcontextprotocol/client/dist/index.mjs"))
);
const { default: matter } = await import(pathToFileURL(join(moduleRoot, "gray-matter/index.js")));

const issuer = "https://issuer.example.test";
const serverUrl = "https://mcp.example.test/api";

async function oauthFixture(storedIssuer = issuer) {
  const store = original.memoryStore();
  await store.saveClientInformation({
    client_id: "fixture-client",
    client_secret: "fixture-secret",
    issuer: storedIssuer,
  });
  await store.saveTokens({
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    token_type: "Bearer",
    issuer: storedIssuer,
  });
  const provider = original.provider({
    config: { url: serverUrl },
    store,
    discovery: {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      },
      resourceMetadata: { resource: serverUrl },
    },
  });
  return { store, provider };
}

test("the original MCP provider refreshes issuer-bound credentials and preserves their binding", async () => {
  const { provider, store } = await oauthFixture();
  let calls = 0;
  const result = await auth(provider, {
    serverUrl,
    fetchFn: async (url, init) => {
      calls++;
      assert.equal(String(url), `${issuer}/token`);
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("grant_type"), "refresh_token");
      assert.equal(init.body.get("refresh_token"), "fixture-refresh");
      return Response.json({
        access_token: "fixture-renewed",
        refresh_token: "fixture-renewed-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  });
  assert.equal(result, "AUTHORIZED");
  assert.equal(calls, 1);
  const tokens = await store.tokens();
  assert.equal(tokens.issuer, issuer);
  assert.equal(tokens.access_token, "fixture-renewed");
  const client = await store.clientInformation();
  const credential = original.toCredential({ methodID: "fixture", serverUrl, tokens, client });
  const restored = original.toTokens(credential);
  assert.equal(restored.issuer, issuer);
  assert.equal(restored.refresh_token, "fixture-renewed-refresh");
  assert.deepEqual(original.clientFromCredential(credential), client);
});

test("the original MCP provider never sends another issuer's credentials to the token endpoint", async () => {
  const { provider, store } = await oauthFixture("https://other-issuer.example.test");
  let calls = 0;
  await assert.rejects(
    auth(provider, {
      serverUrl,
      fetchFn: async () => {
        calls++;
        throw new Error("unexpected fixture request");
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal((await store.tokens()).issuer, "https://other-issuer.example.test");
});

test("the original MCP provider refuses a callback issuer mismatch before token exchange", async () => {
  const { provider } = await oauthFixture();
  let calls = 0;
  await assert.rejects(
    auth(provider, {
      serverUrl,
      authorizationCode: "fixture-code",
      iss: "https://other-issuer.example.test",
      fetchFn: async () => {
        calls++;
        throw new Error("unexpected fixture request");
      },
    }),
    { name: "IssuerMismatchError" },
  );
  assert.equal(calls, 0);
});

test("the original frontmatter consumer retains YAML library parse and stringify behavior", () => {
  const parsed = matter(
    "---\nname: example\ntools:\n  - read\n  - edit\nenabled: true\n---\nBody\n",
  );
  assert.deepEqual(parsed.data, { name: "example", tools: ["read", "edit"], enabled: true });
  assert.equal(parsed.content, "Body\n");
  const restored = matter(matter.stringify(parsed.content, parsed.data));
  assert.deepEqual(restored.data, parsed.data);
  assert.equal(restored.content, parsed.content);
  assert.throws(() => matter("---\nname: [unfinished\n---\nBody\n"));
});

const gitlabProvider = await import(
  pathToFileURL(join(moduleRoot, "gitlab-ai-provider/dist/index.mjs"))
);

test("the original GitLab client validates and retains nonempty direct-access header records", async () => {
  const token = { token: "fixture-token", headers: { "X-Fixture": "fixture-value" } };
  let calls = 0;
  const client = new gitlabProvider.GitLabDirectAccessClient({
    instanceUrl: "https://gitlab.example.test",
    getHeaders: () => ({ Authorization: "Bearer fixture-access" }),
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://gitlab.example.test/api/v4/ai/third_party_agents/direct_access",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer fixture-access");
      return Response.json(token);
    },
  });
  assert.deepEqual(await client.getDirectAccessToken(), token);
  assert.deepEqual(await client.getDirectAccessToken(), token);
  assert.equal(calls, 1);
});

test("the original GitLab client refuses malformed direct-access token and header fields", async () => {
  for (const token of [
    { token: 1, headers: { "X-Fixture": "fixture-value" } },
    { token: "fixture-token", headers: { "X-Fixture": 1 } },
    { token: "fixture-token" },
  ]) {
    const client = new gitlabProvider.GitLabDirectAccessClient({
      instanceUrl: "https://gitlab.example.test",
      getHeaders: () => ({}),
      fetch: async () => Response.json(token),
    });
    await assert.rejects(client.getDirectAccessToken(), { name: "GitLabError" });
  }
});

test("the original GitLab OAuth schema preserves required scalars and optional refresh tokens", () => {
  const schema = gitlabProvider.gitlabOAuthTokenResponseSchema;
  const token = { access_token: "fixture-access", expires_in: 3600, created_at: 1 };
  assert.deepEqual(schema.parse(token), token);
  const refresh = { ...token, refresh_token: "fixture-refresh" };
  assert.deepEqual(schema.parse(refresh), refresh);
  for (const value of [
    { ...token, access_token: 1 },
    { ...token, expires_in: "3600" },
    { ...token, refresh_token: 1 },
    { access_token: "fixture-access", expires_in: 3600 },
  ])
    assert.equal(schema.safeParse(value).success, false);
});

test("the native provider's Zod refuses an oversized bounded array before validating its elements", async () => {
  const providerEntry = join(moduleRoot, "gitlab-ai-provider/dist/index.mjs");
  const { z } = await import(pathToFileURL(createRequire(providerEntry).resolve("zod")));
  const schema = z.array(z.string()).max(2);
  assert.deepEqual(schema.parse(["first", "second"]), ["first", "second"]);
  const result = schema.safeParse([1, 2, 3]);
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error.issues.map((issue) => issue.code),
    ["too_big"],
  );
});

test("the original OpenAI schema converter retains its supported Zod v3 and v4 inputs", async () => {
  const requireOpenAI = createRequire(join(moduleRoot, "openai/package.json"));
  const { zodResponseFormat } = await import(
    pathToFileURL(join(moduleRoot, "openai/helpers/zod.mjs"))
  );
  for (const specifier of ["zod/v3", "zod"]) {
    const { z } = await import(pathToFileURL(requireOpenAI.resolve(specifier)));
    const response = zodResponseFormat(
      z.object({ name: z.string(), count: z.number() }),
      "fixture",
    );
    assert.equal(response.type, "json_schema");
    assert.equal(response.json_schema.name, "fixture");
    assert.deepEqual(response.json_schema.schema.required, ["name", "count"]);
    assert.equal(response.json_schema.schema.properties.name.type, "string");
    assert.equal(response.json_schema.schema.properties.count.type, "number");
    assert.equal(response.json_schema.schema.additionalProperties, false);
  }
});

import { describe, expect, it } from "vitest";
import {
  preparedPublicationResponse,
  readGithubIssueLinkage,
  targetFromPreparation,
} from "./feedback-publication-records.js";
import type { PgClientLike } from "./postgres-types.js";

const prep = {
  id: "22222222-2222-4222-8222-222222222222",
  item_id: "11111111-1111-4111-8111-111111111111",
  payload_digest: "a".repeat(64),
  source_record_version: 1,
  title_bytes: Buffer.from("Title"),
  body_bytes: Buffer.from("Body"),
  projection_digest: "b".repeat(64),
  reconciliation_marker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
  target_api_origin: "https://api.github.com" as const,
  target_repository_id: "123",
  target_owner: "owner",
  target_repository: "repository",
  target_installation_id: "456",
  target_labels: ["feedback"],
  target_key: "public",
  label_policy_version: "labels-v1",
  target_policy_version: "target-v1",
  target_policy_digest: "c".repeat(64),
  status: "prepared" as const,
  expires_at: new Date("2026-08-01T00:00:00.000Z"),
};
class Client implements PgClientLike {
  query: PgClientLike["query"] = () => {
    return Promise.resolve({
      rows: [
        {
          item_id: prep.item_id,
          preparation_id: prep.id,
          target_policy_digest: prep.target_policy_digest,
          github_repository_id: "123",
          github_issue_node_id: "node",
          github_issue_number: 7,
          linked_at: prep.expires_at,
        } as never,
      ],
      rowCount: 1,
    });
  };
  release(): void {
    return undefined;
  }
}
describe("feedback publication record accessors", () => {
  it("projects bounded previews and content-free linkage", async () => {
    expect(targetFromPreparation(prep)).toMatchObject({ owner: "owner", repositoryId: "123" });
    expect(preparedPublicationResponse(prep, 1, true)).toMatchObject({
      title: "Title",
      body: "Body",
      replayed: true,
    });
    await expect(readGithubIssueLinkage(new Client(), prep.item_id)).resolves.toMatchObject({
      issueNumber: 7,
      repositoryId: "123",
    });
  });
});

/**
 * The Git object format of a full object id: a SHA-1 id has 40 hex digits, a SHA-256 id 64. The
 * review runner needs it to read `.gitattributes` from the empty tree of the same format
 * (`neutralizeTreeAttributes`), so the reviewed head can never steer how its files are read.
 */
export function reviewObjectFormat(objectId: string): "sha1" | "sha256" {
  return objectId.length === 40 ? "sha1" : "sha256";
}

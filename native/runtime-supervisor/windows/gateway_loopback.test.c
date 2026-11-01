/* Update rules of the per-run loopback exemption (#4068 W1/W11), checked against an in-memory
 * stand-in for FirewallAPI's configuration list so no administrator rights are needed. The
 * stand-in allocates returned entries on the process heap exactly as the real API documents, so
 * the module's release path is exercised too. */
#include "gateway_loopback.h"

#include <stdio.h>
#include <string.h>

#define MAX_ENTRIES 8

static PSID stored[MAX_ENTRIES];
static DWORD stored_count;
static DWORD writes;
static DWORD fail_get;
static DWORD fail_set;

static PSID make_sid(DWORD rid) {
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  PSID sid = NULL;
  if (!AllocateAndInitializeSid(&authority, 8, SECURITY_APP_PACKAGE_BASE_RID, 1, 2, 3, 4, 5, 6,
                                rid, &sid))
    return NULL;
  return sid;
}

static PSID heap_copy(PSID sid) {
  DWORD size = GetLengthSid(sid);
  PSID copy = HeapAlloc(GetProcessHeap(), 0, size);
  if (copy != NULL && !CopySid(size, copy, sid)) {
    HeapFree(GetProcessHeap(), 0, copy);
    copy = NULL;
  }
  return copy;
}

static DWORD WINAPI fake_get(DWORD *count, PSID_AND_ATTRIBUTES *entries) {
  PSID_AND_ATTRIBUTES list;
  DWORD index;
  if (fail_get != ERROR_SUCCESS) return fail_get;
  list = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*list) * (stored_count + 1));
  if (list == NULL) return ERROR_OUTOFMEMORY;
  for (index = 0; index < stored_count; index++) list[index].Sid = heap_copy(stored[index]);
  *count = stored_count;
  *entries = list;
  return ERROR_SUCCESS;
}

static DWORD WINAPI fake_set(DWORD count, PSID_AND_ATTRIBUTES entries) {
  DWORD index;
  writes++;
  if (fail_set != ERROR_SUCCESS) return fail_set;
  if (count > MAX_ENTRIES) return ERROR_INVALID_PARAMETER;
  for (index = 0; index < stored_count; index++) FreeSid(stored[index]);
  /* Every SID in these tests differs only in its last RID, so the stored copy is rebuilt from it. */
  for (index = 0; index < count; index++) {
    stored[index] = make_sid(*GetSidSubAuthority(entries[index].Sid, 7));
    if (stored[index] == NULL) return ERROR_OUTOFMEMORY;
  }
  stored_count = count;
  return ERROR_SUCCESS;
}

static void reset(PSID first, PSID second) {
  DWORD index;
  for (index = 0; index < stored_count; index++) FreeSid(stored[index]);
  stored_count = 0;
  if (first != NULL) stored[stored_count++] = make_sid(*GetSidSubAuthority(first, 7));
  if (second != NULL) stored[stored_count++] = make_sid(*GetSidSubAuthority(second, 7));
  writes = 0;
  fail_get = ERROR_SUCCESS;
  fail_set = ERROR_SUCCESS;
}

static int holds(PSID sid) {
  DWORD index, seen = 0;
  for (index = 0; index < stored_count; index++) seen += EqualSid(stored[index], sid) ? 1u : 0u;
  return (int)seen;
}

static int failures;

static void expect(int condition, const char *name) {
  if (!condition) {
    failures++;
    printf("FAIL %s\n", name);
  } else {
    printf("ok   %s\n", name);
  }
}

int main(void) {
  PSID other = make_sid(11), another = make_sid(12), ours = make_sid(42);
  if (other == NULL || another == NULL || ours == NULL) return 2;

  reset(other, another);
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 1) == ERROR_SUCCESS &&
             stored_count == 3 && holds(ours) == 1 && holds(other) == 1 && holds(another) == 1,
         "exempt adds the run's SID and keeps every other entry");
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 1) == ERROR_SUCCESS &&
             holds(ours) == 1 && writes == 1,
         "exempting a present SID neither duplicates it nor rewrites the list");
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 0) == ERROR_SUCCESS &&
             stored_count == 2 && holds(ours) == 0 && holds(other) == 1 && holds(another) == 1,
         "revoke removes only the run's SID");
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 0) == ERROR_SUCCESS && writes == 2,
         "revoking an absent SID does not rewrite the list");

  reset(NULL, NULL);
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 1) == ERROR_SUCCESS &&
             stored_count == 1 && holds(ours) == 1,
         "exempt works on an empty list");

  reset(other, NULL);
  fail_get = ERROR_ACCESS_DENIED;
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 1) == ERROR_ACCESS_DENIED &&
             writes == 0 && holds(ours) == 0,
         "a failed read is reported and nothing is written");

  reset(other, NULL);
  fail_set = ERROR_ACCESS_DENIED;
  expect(keiko_gateway_loopback_apply(fake_get, fake_set, ours, 1) == ERROR_ACCESS_DENIED &&
             holds(ours) == 0 && holds(other) == 1,
         "a failed write is reported and the list is unchanged");

  reset(NULL, NULL);
  expect(keiko_gateway_loopback_apply(NULL, fake_set, ours, 1) == ERROR_INVALID_PARAMETER &&
             keiko_gateway_loopback_apply(fake_get, fake_set, NULL, 1) == ERROR_INVALID_PARAMETER &&
             writes == 0,
         "missing functions or SID are refused before any change");

  reset(NULL, NULL);
  FreeSid(other);
  FreeSid(another);
  FreeSid(ours);
  printf("loopback-exemption: %s (%d failure%s)\n", failures == 0 ? "PASS" : "FAIL", failures,
         failures == 1 ? "" : "s");
  return failures == 0 ? 0 : 1;
}

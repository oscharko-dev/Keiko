/* #4068: the filesystem grants of a confined tree. Needs no administrator rights: the frame rules
 * run in memory, and the grant rules use fresh temporary directories this test owns. */
#include "gateway_grants.h"

#include <aclapi.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <userenv.h>
#pragma comment(lib, "userenv.lib")

static size_t put_text(unsigned char *at, const char *text) {
  uint32_t length = (uint32_t)strlen(text);
  at[0] = (unsigned char)length;
  at[1] = (unsigned char)(length >> 8);
  at[2] = (unsigned char)(length >> 16);
  at[3] = (unsigned char)(length >> 24);
  memcpy(at + 4, text, length);
  return 4 + (size_t)length;
}

/* One frame with up to two entries: (access, principal, path[, capability]). */
static size_t frame_of(unsigned char *frame, int count, int access, int principal,
                       const char *path, const char *capability) {
  size_t at = 14;
  memcpy(frame, "KGG1", 4);
  frame[4] = 1;
  frame[5] = 0;
  frame[6] = 1;
  frame[7] = 0;
  frame[12] = (unsigned char)count;
  frame[13] = 0;
  for (int index = 0; index < count; index++) {
    frame[at++] = (unsigned char)access;
    frame[at++] = (unsigned char)principal;
    at += put_text(frame + at, path);
    if (capability != NULL) at += put_text(frame + at, capability);
  }
  frame[8] = (unsigned char)(at - 12);
  frame[9] = (unsigned char)((at - 12) >> 8);
  frame[10] = 0;
  frame[11] = 0;
  return at;
}

static int parses(const unsigned char *frame, size_t length) {
  struct keiko_gateway_grants grants = {0};
  int ok = keiko_gateway_grants_parse(frame, length, &grants);
  keiko_gateway_grants_clear(&grants);
  return ok;
}

static const char CAPABILITY[] = "keiko.workspace.0123456789abcdef0123456789abcdef";

static int frame_rules(void) {
  unsigned char frame[1024];
  struct keiko_gateway_grants grants;
  size_t length = frame_of(frame, 1, KEIKO_GRANT_MODIFY, KEIKO_GRANT_TREE, "C:\\run\\state", NULL);
  if (!keiko_gateway_grants_parse(frame, length, &grants) || grants.count != 1 ||
      wcscmp(grants.entries[0].path, L"C:\\run\\state") != 0)
    return 0;
  keiko_gateway_grants_clear(&grants);
  if (!parses(frame, frame_of(frame, 0, 0, 0, "", NULL))) return 0;
  if (!parses(frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_CAPABILITY, "D:\\w",
                              CAPABILITY)))
    return 0;
  /* Write access is never given to a capability. */
  if (parses(frame, frame_of(frame, 1, KEIKO_GRANT_MODIFY, KEIKO_GRANT_CAPABILITY, "D:\\w",
                             CAPABILITY)))
    return 0;
  {
    static const char *refused_paths[] = {"run\\state", "C:/run",     "C:\\run\\..\\x",
                                          "C:\\run\\.", "\\\\?\\C:\\x", "C:\\x:stream"};
    for (size_t index = 0; index < sizeof(refused_paths) / sizeof(*refused_paths); index++)
      if (parses(frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE,
                                 refused_paths[index], NULL)))
        return 0;
  }
  if (parses(frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_CAPABILITY, "D:\\w",
                             "keiko.workspace.NOT-HEX")))
    return 0;
  if (parses(frame, frame_of(frame, 1, 3, KEIKO_GRANT_TREE, "C:\\run", NULL))) return 0;
  length = frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE, "C:\\run", NULL);
  frame[length] = 0;
  /* Trailing bytes, a short frame and another magic are each refused. */
  return !parses(frame, length + 1) && !parses(frame, length - 1) &&
         (memcpy(frame, "KGB1", 4), !parses(frame, length));
}

static int temporary_directory(wchar_t *path, const wchar_t *name) {
  wchar_t base[MAX_PATH];
  DWORD length = GetTempPathW(MAX_PATH, base);
  if (length == 0 || length >= MAX_PATH) return 0;
  if (_snwprintf_s(path, MAX_PATH, _TRUNCATE, L"%lskeiko-grants-%ls-%lu", base, name,
                   GetCurrentProcessId()) <= 0)
    return 0;
  RemoveDirectoryW(path);
  return CreateDirectoryW(path, NULL);
}

/* Counts this SID's allowed entries on the directory itself. */
static int entries_for(const wchar_t *path, PSID sid) {
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  ACL_SIZE_INFORMATION size;
  int count = 0;
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &dacl,
                            NULL, &descriptor) != ERROR_SUCCESS)
    return -1;
  if (dacl != NULL && GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation)) {
    for (DWORD index = 0; index < size.AceCount; index++) {
      ACCESS_ALLOWED_ACE *ace = NULL;
      if (GetAce(dacl, index, (LPVOID *)&ace) && ace != NULL &&
          ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid((PSID)&ace->SidStart, sid))
        count++;
    }
  }
  LocalFree(descriptor);
  return count;
}

static int grant_rules(void) {
  wchar_t state[MAX_PATH] = L"", worktree[MAX_PATH] = L"";
  unsigned char frame[2048];
  char state_utf8[MAX_PATH * 3], worktree_utf8[MAX_PATH * 3];
  struct keiko_gateway_grants grants = {0};
  PSID tree = NULL;
  int ok = 0;
  size_t at;
  if (!temporary_directory(state, L"state") || !temporary_directory(worktree, L"worktree") ||
      FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.GrantsTest", &tree)) ||
      WideCharToMultiByte(CP_UTF8, 0, state, -1, state_utf8, sizeof(state_utf8), NULL, NULL) <= 0 ||
      WideCharToMultiByte(CP_UTF8, 0, worktree, -1, worktree_utf8, sizeof(worktree_utf8), NULL,
                          NULL) <= 0)
    goto done;
  /* Two entries of different shapes: build them one after the other. */
  at = frame_of(frame, 1, KEIKO_GRANT_MODIFY, KEIKO_GRANT_TREE, state_utf8, NULL);
  frame[12] = 2;
  frame[at++] = KEIKO_GRANT_READ;
  frame[at++] = KEIKO_GRANT_CAPABILITY;
  at += put_text(frame + at, worktree_utf8);
  at += put_text(frame + at, CAPABILITY);
  frame[8] = (unsigned char)(at - 12);
  frame[9] = (unsigned char)((at - 12) >> 8);
  if (!keiko_gateway_grants_parse(frame, at, &grants)) goto done;
  if (keiko_gateway_grants_apply(&grants, tree) != KEIKO_GRANTS_APPLIED ||
      grants.capability_count != 1 ||
      entries_for(state, tree) != 1 || entries_for(worktree, grants.capabilities[0].Sid) != 1)
    goto clear;
  keiko_gateway_grants_revoke(&grants, tree);
  /* The tree's own entry is gone; the worktree keeps its capability, and a second run adds none. */
  if (entries_for(state, tree) != 0 || entries_for(worktree, grants.capabilities[0].Sid) != 1)
    goto clear;
  keiko_gateway_grants_clear(&grants);
  if (!keiko_gateway_grants_parse(frame, at, &grants) ||
      keiko_gateway_grants_apply(&grants, tree) != KEIKO_GRANTS_APPLIED ||
      entries_for(worktree, grants.capabilities[0].Sid) != 1)
    goto clear;
  keiko_gateway_grants_revoke(&grants, tree);
  ok = 1;
clear:
  keiko_gateway_grants_clear(&grants);
done:
  if (tree != NULL) FreeSid(tree);
  if (state[0] != L'\0') RemoveDirectoryW(state);
  if (worktree[0] != L'\0') RemoveDirectoryW(worktree);
  return ok;
}

static int missing_directory_rules(void) {
  unsigned char frame[512];
  struct keiko_gateway_grants grants;
  PSID tree = NULL;
  int ok = 0;
  size_t length =
      frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE, "C:\\keiko-grants-missing-dir", NULL);
  if (FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.GrantsTest", &tree)))
    return 0;
  if (keiko_gateway_grants_parse(frame, length, &grants))
    ok = keiko_gateway_grants_apply(&grants, tree) == KEIKO_GRANTS_REFUSED_DIRECTORY &&
         grants.capability_count == 0;
  keiko_gateway_grants_clear(&grants);
  FreeSid(tree);
  return ok;
}

int main(void) {
  if (!frame_rules()) { puts("gateway-grants-frame: failed"); return 1; }
  if (!grant_rules()) { puts("gateway-grants-apply: failed"); return 1; }
  if (!missing_directory_rules()) { puts("gateway-grants-missing: failed"); return 1; }
  puts("gateway-grants-rules: passed");
  return 0;
}

/* #4068: the filesystem grants of a confined tree. Needs no administrator rights: the frame rules
 * run in memory, and the grant rules use fresh temporary directories this test owns. */
#include "gateway_grants.h"

#include <aclapi.h>
#include <sddl.h>
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
                                          "C:\\run\\.", "\\\\?\\C:\\x", "C:\\x:stream",
                                          "C:\\", "d:\\", "C:\\\\x"};
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

/* An inheritable allow entry with any mask, as another tool could have written it. */
static int add_entry(const wchar_t *path, PSID sid, DWORD mask) {
  PACL before = NULL, after = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  EXPLICIT_ACCESSW entry;
  DWORD result;
  memset(&entry, 0, sizeof(entry));
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &before,
                            NULL, &descriptor) != ERROR_SUCCESS)
    return 0;
  entry.grfAccessPermissions = mask;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = (LPWSTR)sid;
  result = SetEntriesInAclW(1, &entry, before, &after);
  if (result == ERROR_SUCCESS)
    result = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL,
                                   NULL, after, NULL);
  if (after != NULL) LocalFree(after);
  LocalFree(descriptor);
  return result == ERROR_SUCCESS;
}

/* A frame of one tree entry on `path`, applied for `tree` and never revoked: what a supervisor
 * that died after its grants leaves behind. */
static int crashed_grant(const char *path, int access, PSID tree) {
  unsigned char frame[2048];
  struct keiko_gateway_grants grants = {0};
  int ok = keiko_gateway_grants_parse(frame, frame_of(frame, 1, access, KEIKO_GRANT_TREE, path,
                                                      NULL),
                                      &grants) &&
           keiko_gateway_grants_apply(&grants, tree) == KEIKO_GRANTS_APPLIED;
  keiko_gateway_grants_clear(&grants);
  return ok;
}

/* #4068 B1 crash rule: a sweep removes exactly the tree entries crashed runs left, and nothing a
 * tree grant does not write: another mask, a well-known package group, or a capability. */
static int sweep_rules(void) {
  wchar_t root[MAX_PATH] = L"";
  char root_utf8[MAX_PATH * 3];
  unsigned char frame[2048];
  struct keiko_gateway_grants grants = {0};
  struct keiko_gateway_sweep sweep = {0};
  PSID read_stale = NULL, modify_stale = NULL, other = NULL, packages = NULL;
  int ok = 0;
  if (!temporary_directory(root, L"sweep") ||
      WideCharToMultiByte(CP_UTF8, 0, root, -1, root_utf8, sizeof(root_utf8), NULL, NULL) <= 0 ||
      FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.SweepRead", &read_stale)) ||
      FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.SweepModify",
                                                       &modify_stale)) ||
      FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.SweepOther", &other)) ||
      !ConvertStringSidToSidW(L"S-1-15-2-1", &packages))
    goto done;
  if (!crashed_grant(root_utf8, KEIKO_GRANT_READ, read_stale) ||
      !crashed_grant(root_utf8, KEIKO_GRANT_MODIFY, modify_stale) ||
      !add_entry(root, other, FILE_GENERIC_READ) ||
      !add_entry(root, packages, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE))
    goto done;
  if (!keiko_gateway_grants_parse(frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE,
                                                  root_utf8, NULL),
                                  &grants))
    goto done;
  sweep.grants = &grants;
  keiko_gateway_grants_sweep(&sweep);
  ok = sweep.removed == 2 && sweep.failed == 0 && entries_for(root, read_stale) == 0 &&
       entries_for(root, modify_stale) == 0 && entries_for(root, other) == 1 &&
       entries_for(root, packages) == 1;
  /* A second sweep finds nothing left to remove. */
  sweep.removed = 0;
  keiko_gateway_grants_sweep(&sweep);
  ok = ok && sweep.removed == 0 && sweep.failed == 0;
  keiko_gateway_grants_clear(&grants);
  /* A directory that is gone is not counted as a failure: nothing there can grant anything. */
  sweep.removed = 0;
  sweep.failed = 0;
  ok = ok &&
       keiko_gateway_grants_parse(frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE,
                                                  "C:\\keiko-grants-missing-dir", NULL),
                                  &grants);
  if (ok) keiko_gateway_grants_sweep(&sweep);
  ok = ok && sweep.removed == 0 && sweep.failed == 0;
  keiko_gateway_grants_clear(&grants);
done:
  if (read_stale != NULL) FreeSid(read_stale);
  if (modify_stale != NULL) FreeSid(modify_stale);
  if (other != NULL) FreeSid(other);
  if (packages != NULL) LocalFree(packages);
  if (root[0] != L'\0') RemoveDirectoryW(root);
  return ok;
}

/* Two tree entries on different paths, built one after the other. */
static size_t frame_two(unsigned char *frame, const char *first, int first_access,
                        const char *second, int second_access) {
  size_t at = frame_of(frame, 1, first_access, KEIKO_GRANT_TREE, first, NULL);
  frame[12] = 2;
  frame[at++] = (unsigned char)second_access;
  frame[at++] = KEIKO_GRANT_TREE;
  at += put_text(frame + at, second);
  frame[8] = (unsigned char)(at - 12);
  frame[9] = (unsigned char)((at - 12) >> 8);
  return at;
}

/* Whether the folder carries exactly one entry for `sid`: explicit, not inherited, the list mask. */
static int list_entry_only(const wchar_t *path, PSID sid) {
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  ACL_SIZE_INFORMATION size;
  int found = 0, other = 0;
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &dacl,
                            NULL, &descriptor) != ERROR_SUCCESS)
    return 0;
  if (dacl != NULL && GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation)) {
    for (DWORD index = 0; index < size.AceCount; index++) {
      ACCESS_ALLOWED_ACE *ace = NULL;
      if (!GetAce(dacl, index, (LPVOID *)&ace) || ace == NULL ||
          !EqualSid((PSID)&ace->SidStart, sid))
        continue;
      if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
          ace->Mask == KEIKO_GATEWAY_ANCESTOR_MASK)
        found++;
      else
        other++;
    }
  }
  LocalFree(descriptor);
  return found == 1 && other == 0;
}

static int child_directory(wchar_t *path, const wchar_t *parent, const wchar_t *name) {
  if (_snwprintf_s(path, MAX_PATH, _TRUNCATE, L"%ls\\%ls", parent, name) <= 0) return 0;
  return CreateDirectoryW(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

struct ancestor_tree {
  wchar_t root[MAX_PATH], a[MAX_PATH], b[MAX_PATH], c[MAX_PATH], side[MAX_PATH];
  char root_utf8[MAX_PATH * 3], a_utf8[MAX_PATH * 3], c_utf8[MAX_PATH * 3];
};

static int ancestor_tree_make(struct ancestor_tree *t) {
  memset(t, 0, sizeof(*t));
  return temporary_directory(t->root, L"ancestors") && child_directory(t->a, t->root, L"a") &&
         child_directory(t->b, t->a, L"b") && child_directory(t->c, t->b, L"c") &&
         child_directory(t->side, t->root, L"side") &&
         WideCharToMultiByte(CP_UTF8, 0, t->root, -1, t->root_utf8, sizeof(t->root_utf8), NULL,
                             NULL) > 0 &&
         WideCharToMultiByte(CP_UTF8, 0, t->a, -1, t->a_utf8, sizeof(t->a_utf8), NULL, NULL) > 0 &&
         WideCharToMultiByte(CP_UTF8, 0, t->c, -1, t->c_utf8, sizeof(t->c_utf8), NULL, NULL) > 0;
}

static void ancestor_tree_remove(struct ancestor_tree *t) {
  const wchar_t *order[] = {t->c, t->b, t->a, t->side, t->root};
  for (size_t index = 0; index < sizeof(order) / sizeof(order[0]); index++)
    if (order[index][0] != L'\0') RemoveDirectoryW(order[index]);
}

/* #4496: the folders above a grant inside the profile get a list entry for the tree alone, the
 * entry inherits nowhere, a revoke removes it, and a sweep removes a crashed run's entries. */
static int ancestor_apply_rules(struct ancestor_tree *t, PSID tree) {
  unsigned char frame[2048];
  struct keiko_gateway_grants grants = {0};
  struct keiko_gateway_sweep sweep = {0};
  int ok = keiko_gateway_grants_parse(
               frame, frame_of(frame, 1, KEIKO_GRANT_MODIFY, KEIKO_GRANT_TREE, t->c_utf8, NULL),
               &grants) &&
           keiko_gateway_ancestors_plan(&grants, t->root) && grants.ancestor_count == 3 &&
           keiko_gateway_grants_apply(&grants, tree) == KEIKO_GRANTS_APPLIED &&
           list_entry_only(t->root, tree) && list_entry_only(t->a, tree) &&
           list_entry_only(t->b, tree) && entries_for(t->c, tree) == 1 &&
           entries_for(t->side, tree) == 0;
  if (ok) keiko_gateway_grants_revoke(&grants, tree);
  ok = ok && entries_for(t->root, tree) == 0 && entries_for(t->a, tree) == 0 &&
       entries_for(t->b, tree) == 0 && entries_for(t->c, tree) == 0;
  /* A run that dies after its grants: the next run's sweep removes all four of its entries. */
  ok = ok && keiko_gateway_grants_apply(&grants, tree) == KEIKO_GRANTS_APPLIED;
  keiko_gateway_grants_clear(&grants);
  ok = ok &&
       keiko_gateway_grants_parse(
           frame, frame_of(frame, 1, KEIKO_GRANT_MODIFY, KEIKO_GRANT_TREE, t->c_utf8, NULL),
           &grants) &&
       keiko_gateway_ancestors_plan(&grants, t->root);
  sweep.grants = &grants;
  if (ok) keiko_gateway_grants_sweep(&sweep);
  ok = ok && sweep.removed == 4 && sweep.failed == 0 && entries_for(t->root, tree) == 0 &&
       entries_for(t->a, tree) == 0 && entries_for(t->b, tree) == 0;
  keiko_gateway_grants_clear(&grants);
  return ok;
}

/* A folder a grant covers plans nothing; a grant outside the profile plans nothing; a profile in
 * another shape and a chain deeper than the bound are refused. */
static int ancestor_plan_rules(struct ancestor_tree *t) {
  unsigned char frame[4096];
  char deep[MAX_PATH * 3];
  wchar_t trailing[MAX_PATH];
  struct keiko_gateway_grants grants = {0};
  size_t at;
  int ok = keiko_gateway_grants_parse(frame, frame_two(frame, t->a_utf8, KEIKO_GRANT_READ,
                                                       t->c_utf8, KEIKO_GRANT_MODIFY),
                                      &grants) &&
           keiko_gateway_ancestors_plan(&grants, t->root) && grants.ancestor_count == 1;
  keiko_gateway_grants_clear(&grants);
  ok = ok &&
       keiko_gateway_grants_parse(
           frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE, t->root_utf8, NULL),
           &grants) &&
       keiko_gateway_ancestors_plan(&grants, t->a) && grants.ancestor_count == 0;
  _snwprintf_s(trailing, MAX_PATH, _TRUNCATE, L"%ls\\", t->root);
  ok = ok && !keiko_gateway_ancestors_plan(&grants, trailing) &&
       !keiko_gateway_ancestors_plan(&grants, L"relative\\profile");
  keiko_gateway_grants_clear(&grants);
  at = (size_t)_snprintf_s(deep, sizeof(deep), _TRUNCATE, "%s", t->root_utf8);
  for (int level = 0; level < KEIKO_GATEWAY_ANCESTORS_MAX + 2 && at + 3 < sizeof(deep); level++)
    at += (size_t)_snprintf_s(deep + at, sizeof(deep) - at, _TRUNCATE, "\\d");
  ok = ok &&
       keiko_gateway_grants_parse(
           frame, frame_of(frame, 1, KEIKO_GRANT_READ, KEIKO_GRANT_TREE, deep, NULL), &grants) &&
       !keiko_gateway_ancestors_plan(&grants, t->root);
  keiko_gateway_grants_clear(&grants);
  return ok;
}

static int ancestor_rules(void) {
  struct ancestor_tree tree_folders;
  PSID tree = NULL;
  int ok = ancestor_tree_make(&tree_folders) &&
           SUCCEEDED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.AncestorTest",
                                                               &tree)) &&
           ancestor_apply_rules(&tree_folders, tree) && ancestor_plan_rules(&tree_folders);
  if (tree != NULL) FreeSid(tree);
  ancestor_tree_remove(&tree_folders);
  return ok;
}

#define CONCURRENT_RUNS 8
#define CONCURRENT_ROUNDS 4

struct concurrent_run {
  HANDLE start;
  const char *path;
  PSID tree;
  int applied;
};

static DWORD WINAPI concurrent_apply(LPVOID context) {
  struct concurrent_run *run = context;
  if (WaitForSingleObject(run->start, INFINITE) == WAIT_OBJECT_0)
    run->applied = crashed_grant(run->path, KEIKO_GRANT_READ, run->tree);
  return 0;
}

/* #4068 concurrency rule: runs released together grant the same directory, and every run's entry
 * survives. A DACL edit is a read, a merge and a write, so unserialized edits drop each other's. */
static int concurrent_rules(void) {
  wchar_t root[MAX_PATH] = L"";
  char root_utf8[MAX_PATH * 3];
  struct concurrent_run runs[CONCURRENT_RUNS] = {0};
  HANDLE threads[CONCURRENT_RUNS] = {0};
  HANDLE start = CreateEventW(NULL, TRUE, FALSE, NULL);
  int ok = start != NULL && temporary_directory(root, L"concurrent") &&
           WideCharToMultiByte(CP_UTF8, 0, root, -1, root_utf8, sizeof(root_utf8), NULL, NULL) > 0;
  for (int round = 0; ok && round < CONCURRENT_ROUNDS; round++) {
    int started = 0;
    ResetEvent(start);
    for (int index = 0; index < CONCURRENT_RUNS; index++) {
      wchar_t name[64];
      swprintf(name, 64, L"Keiko.Gateway.Concurrent.%d.%d", round, index);
      runs[index].start = start;
      runs[index].path = root_utf8;
      runs[index].applied = 0;
      runs[index].tree = NULL;
      if (FAILED(DeriveAppContainerSidFromAppContainerName(name, &runs[index].tree))) break;
      threads[index] = CreateThread(NULL, 0, concurrent_apply, &runs[index], 0, NULL);
      if (threads[index] == NULL) break;
      started++;
    }
    SetEvent(start);
    if (started > 0) WaitForMultipleObjects((DWORD)started, threads, TRUE, INFINITE);
    ok = started == CONCURRENT_RUNS;
    for (int index = 0; index < started; index++) {
      ok = ok && runs[index].applied && entries_for(root, runs[index].tree) == 1;
      CloseHandle(threads[index]);
    }
    for (int index = 0; index < CONCURRENT_RUNS; index++) {
      if (runs[index].tree != NULL) FreeSid(runs[index].tree);
      runs[index].tree = NULL;
    }
  }
  if (start != NULL) CloseHandle(start);
  if (root[0] != L'\0') RemoveDirectoryW(root);
  return ok;
}

/* One entry for ALL APPLICATION PACKAGES with the given mode, mask and inheritance. */
static int packages_entry(const wchar_t *path, ACCESS_MODE mode, DWORD mask, DWORD inheritance) {
  SID_IDENTIFIER_AUTHORITY app = SECURITY_APP_PACKAGE_AUTHORITY;
  PSID packages = NULL;
  PACL before = NULL, after = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  EXPLICIT_ACCESSW entry;
  DWORD result = ERROR_INVALID_PARAMETER;
  memset(&entry, 0, sizeof(entry));
  if (!AllocateAndInitializeSid(&app, SECURITY_BUILTIN_APP_PACKAGE_RID_COUNT,
                                SECURITY_APP_PACKAGE_BASE_RID, SECURITY_BUILTIN_PACKAGE_ANY_PACKAGE,
                                0, 0, 0, 0, 0, 0, &packages))
    return 0;
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &before,
                            NULL, &descriptor) == ERROR_SUCCESS) {
    entry.grfAccessPermissions = mask;
    entry.grfAccessMode = mode;
    entry.grfInheritance = inheritance;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    entry.Trustee.ptstrName = (LPWSTR)packages;
    result = SetEntriesInAclW(1, &entry, before, &after);
    if (result == ERROR_SUCCESS)
      result = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL,
                                     NULL, after, NULL);
  }
  if (after != NULL) LocalFree(after);
  LocalFree(descriptor);
  FreeSid(packages);
  return result == ERROR_SUCCESS;
}

/* Applies a one-entry tree frame on `path` and reports the result and the tree's own entries. */
static int tree_grant(const char *path, int access, PSID tree, int *entries,
                      const wchar_t *wide) {
  unsigned char frame[2048];
  struct keiko_gateway_grants grants = {0};
  int result = -1;
  if (keiko_gateway_grants_parse(frame, frame_of(frame, 1, access, KEIKO_GRANT_TREE, path, NULL),
                                 &grants)) {
    result = keiko_gateway_grants_apply(&grants, tree);
    *entries = entries_for(wide, tree);
    keiko_gateway_grants_revoke(&grants, tree);
  }
  keiko_gateway_grants_clear(&grants);
  return result;
}

/* #4068: a directory every AppContainer already reads, as Program Files does with one entry for the
 * directory and an inherit-only one for its content, takes a read grant without any DACL edit; a
 * write grant still takes the tree's own entry, and a deny entry for the group voids the shortcut. */
static int packages_rules(void) {
  wchar_t shared[MAX_PATH] = L"", plain[MAX_PATH] = L"";
  char shared_utf8[MAX_PATH * 3];
  PSID tree = NULL;
  int ok = 0, entries = -1;
  if (!temporary_directory(shared, L"packages") || !temporary_directory(plain, L"plain") ||
      FAILED(DeriveAppContainerSidFromAppContainerName(L"Keiko.Gateway.PackagesTest", &tree)) ||
      WideCharToMultiByte(CP_UTF8, 0, shared, -1, shared_utf8, sizeof(shared_utf8), NULL, NULL) <=
          0)
    goto done;
  if (keiko_gateway_grants_packages_read(shared) || keiko_gateway_grants_packages_read(plain) ||
      !packages_entry(shared, GRANT_ACCESS, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                      NO_INHERITANCE) ||
      keiko_gateway_grants_packages_read(shared) ||
      !packages_entry(shared, GRANT_ACCESS, GENERIC_READ | GENERIC_EXECUTE,
                      SUB_CONTAINERS_AND_OBJECTS_INHERIT | INHERIT_ONLY) ||
      !keiko_gateway_grants_packages_read(shared))
    goto done;
  if (tree_grant(shared_utf8, KEIKO_GRANT_READ, tree, &entries, shared) != KEIKO_GRANTS_APPLIED ||
      entries != 0)
    goto done;
  if (tree_grant(shared_utf8, KEIKO_GRANT_MODIFY, tree, &entries, shared) !=
          KEIKO_GRANTS_APPLIED ||
      entries != 1 || entries_for(shared, tree) != 0)
    goto done;
  if (!packages_entry(shared, DENY_ACCESS, FILE_WRITE_DATA, NO_INHERITANCE) ||
      keiko_gateway_grants_packages_read(shared))
    goto done;
  ok = 1;
done:
  if (tree != NULL) FreeSid(tree);
  if (shared[0] != L'\0') RemoveDirectoryW(shared);
  if (plain[0] != L'\0') RemoveDirectoryW(plain);
  return ok;
}

int main(void) {
  if (!frame_rules()) { puts("gateway-grants-frame: failed"); return 1; }
  if (!packages_rules()) { puts("gateway-grants-packages: failed"); return 1; }
  if (!grant_rules()) { puts("gateway-grants-apply: failed"); return 1; }
  if (!missing_directory_rules()) { puts("gateway-grants-missing: failed"); return 1; }
  if (!sweep_rules()) { puts("gateway-grants-sweep: failed"); return 1; }
  if (!concurrent_rules()) { puts("gateway-grants-concurrent: failed"); return 1; }
  if (!ancestor_rules()) { puts("gateway-grants-ancestors: failed"); return 1; }
  puts("gateway-grants-rules: passed");
  return 0;
}

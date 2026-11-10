/* #4068: the filesystem grants of a confined run's per-tree AppContainer (ADR-0043 D18). The tree's
 * own SID receives the runtime and the run's private state, revoked when the tree is reaped. A stale
 * entry left by a crash names a SID derived from a per-run nonce no later process can obtain, so it
 * grants nothing. A Keiko-managed worktree is granted once, inheritably, to a capability derived from
 * its identity; only runs of that worktree carry the capability, and no run walks the repository
 * again. */
#include "gateway_grants.h"

#include <aclapi.h>
#include <io.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t grant_u16(const unsigned char *value) {
  return (uint16_t)(value[0] | (value[1] << 8));
}

static uint32_t grant_u32(const unsigned char *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8) | ((uint32_t)value[2] << 16) |
         ((uint32_t)value[3] << 24);
}

static wchar_t *wide_utf8(const unsigned char *bytes, uint32_t length) {
  wchar_t *value;
  int count;
  if (length == 0 || length > INT_MAX) return NULL;
  count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length,
                              NULL, 0);
  if (count <= 0) return NULL;
  value = calloc((size_t)count + 1, sizeof(*value));
  if (value == NULL) return NULL;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length, value,
                          count) != count ||
      wcslen(value) != (size_t)count) {
    free(value);
    return NULL;
  }
  return value;
}

static int take_text(const unsigned char **cursor, size_t *remaining, uint32_t maximum,
                     wchar_t **value) {
  uint32_t length;
  if (*remaining < 4) return 0;
  length = grant_u32(*cursor);
  if (length == 0 || length > maximum || length > *remaining - 4) return 0;
  *value = wide_utf8(*cursor + 4, length);
  *cursor += 4 + (size_t)length;
  *remaining -= 4 + (size_t)length;
  return *value != NULL;
}

/* The real path the host resolved: `X:\` and plain components, with no relative component, forward
 * slash, stream, device or extended-length syntax. */
static int canonical_drive_path(const wchar_t *path) {
  size_t length = wcslen(path);
  wchar_t drive;
  if (length < 3 || path[1] != L':' || path[2] != L'\\') return 0;
  drive = path[0];
  if (!((drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z'))) return 0;
  if (wcschr(path + 2, L':') != NULL || wcschr(path, L'/') != NULL) return 0;
  if (wcsstr(path, L"\\.\\") != NULL || wcsstr(path, L"\\..\\") != NULL) return 0;
  if (wcscmp(path + length - 2, L"\\.") == 0) return 0;
  return length < 4 || wcscmp(path + length - 3, L"\\..") != 0;
}

static int valid_capability(const wchar_t *name) {
  static const wchar_t prefix[] = L"keiko.workspace.";
  size_t prefix_length = wcslen(prefix);
  if (wcsncmp(name, prefix, prefix_length) != 0 || wcslen(name) != prefix_length + 32) return 0;
  for (size_t index = prefix_length; name[index] != L'\0'; index++) {
    wchar_t c = name[index];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return 0;
  }
  return 1;
}

static int parse_entry(const unsigned char **cursor, size_t *remaining,
                       struct keiko_gateway_grant *grant) {
  if (*remaining < 2) return 0;
  grant->access = (*cursor)[0];
  grant->principal = (*cursor)[1];
  *cursor += 2;
  *remaining -= 2;
  if (grant->access != KEIKO_GRANT_READ && grant->access != KEIKO_GRANT_MODIFY) return 0;
  if (grant->principal != KEIKO_GRANT_TREE && grant->principal != KEIKO_GRANT_CAPABILITY) return 0;
  /* Write access only ever goes to the tree's own SID. */
  if (grant->principal == KEIKO_GRANT_CAPABILITY && grant->access != KEIKO_GRANT_READ) return 0;
  if (!take_text(cursor, remaining, KEIKO_GATEWAY_GRANT_PATH_MAX_BYTES, &grant->path) ||
      !canonical_drive_path(grant->path))
    return 0;
  return grant->principal == KEIKO_GRANT_TREE ||
         (take_text(cursor, remaining, 64, &grant->capability) &&
          valid_capability(grant->capability));
}

int keiko_gateway_grants_parse(_In_reads_bytes_opt_(length) const unsigned char *frame,
                               size_t length, _Out_ struct keiko_gateway_grants *grants) {
  const unsigned char *cursor;
  size_t remaining;
  uint16_t count;
  memset(grants, 0, sizeof(*grants));
  if (frame == NULL || length < 14 || length - 12 > KEIKO_GATEWAY_GRANTS_MAX_BYTES ||
      memcmp(frame, "KGG1", 4) != 0 || grant_u16(frame + 4) != 1 || grant_u16(frame + 6) != 1 ||
      grant_u32(frame + 8) != length - 12)
    return 0;
  cursor = frame + 12;
  remaining = length - 12;
  count = grant_u16(cursor);
  cursor += 2;
  remaining -= 2;
  if (count > KEIKO_GATEWAY_GRANTS_MAX) return 0;
  for (uint16_t index = 0; index < count; index++) {
    struct keiko_gateway_grant empty = {0};
    grants->entries[index] = empty;
    grants->count = (size_t)index + 1;
    if (!parse_entry(&cursor, &remaining, &grants->entries[index])) {
      keiko_gateway_grants_clear(grants);
      return 0;
    }
  }
  if (remaining == 0) return 1;
  keiko_gateway_grants_clear(grants);
  return 0;
}

static int read_all(int descriptor, unsigned char *buffer, size_t length) {
  while (length > 0) {
    int chunk = _read(descriptor, buffer, length > INT_MAX ? INT_MAX : (unsigned int)length);
    if (chunk <= 0) return 0;
    buffer += chunk;
    length -= (size_t)chunk;
  }
  return 1;
}

int keiko_gateway_grants_read(int descriptor, _Out_ struct keiko_gateway_grants *grants) {
  unsigned char header[12];
  unsigned char *frame;
  uint32_t payload;
  int ok;
  memset(grants, 0, sizeof(*grants));
  if (!read_all(descriptor, header, sizeof(header)) || memcmp(header, "KGG1", 4) != 0) return 0;
  payload = grant_u32(header + 8);
  if (payload < 2 || payload > KEIKO_GATEWAY_GRANTS_MAX_BYTES) return 0;
  frame = malloc(sizeof(header) + payload);
  if (frame == NULL) return 0;
  memcpy(frame, header, sizeof(header));
  ok = read_all(descriptor, frame + sizeof(header), payload) &&
       keiko_gateway_grants_parse(frame, sizeof(header) + payload, grants);
  free(frame);
  return ok;
}

static int plain_directory(const wchar_t *path) {
  FILE_ATTRIBUTE_TAG_INFO info;
  int ok = 0;
  HANDLE handle = CreateFileW(path, FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                              OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                              NULL);
  if (handle == INVALID_HANDLE_VALUE) return 0;
  if (GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)))
    ok = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
         (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
  CloseHandle(handle);
  return ok;
}

static DWORD grant_mask(int access) {
  return access == KEIKO_GRANT_MODIFY
             ? FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE
             : FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
}

/* Concurrent runs share granted directories such as the runtime root, and a DACL edit is a read, a
 * merge and a write. Without one per-session lock, one run's write could drop another run's fresh
 * entry (#4068, ADR-0043 D18). An abandoned lock is still consistent: each DACL write is complete or
 * absent. */
static const wchar_t GRANTS_LOCK[] = L"Local\\Keiko.RuntimeGrants";
#define GRANTS_LOCK_TIMEOUT_MS 30000u

static HANDLE grants_lock(void) {
  HANDLE lock = CreateMutexW(NULL, FALSE, GRANTS_LOCK);
  DWORD waited;
  if (lock == NULL) return NULL;
  waited = WaitForSingleObject(lock, GRANTS_LOCK_TIMEOUT_MS);
  if (waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED) return lock;
  CloseHandle(lock);
  return NULL;
}

static void grants_unlock(HANDLE lock) {
  ReleaseMutex(lock);
  CloseHandle(lock);
}

static DWORD change_entry_locked(wchar_t *path, PSID sid, ACCESS_MODE mode, DWORD mask) {
  PACL before = NULL, after = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  EXPLICIT_ACCESSW entry;
  DWORD result;
  memset(&entry, 0, sizeof(entry));
  result = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                                 &before, NULL, &descriptor);
  if (result != ERROR_SUCCESS) return result;
  entry.grfAccessPermissions = mask;
  entry.grfAccessMode = mode;
  entry.grfInheritance = mode == GRANT_ACCESS ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = (LPWSTR)sid;
  result = SetEntriesInAclW(1, &entry, before, &after);
  if (result == ERROR_SUCCESS)
    result = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                                   after, NULL);
  if (after != NULL) LocalFree(after);
  LocalFree(descriptor);
  return result;
}

/* A lock that cannot be taken fails the edit: a grant refuses the launch, and a revoke leaves the
 * tree's own entry for the next sweep rather than racing another run's write. */
static DWORD change_entry(wchar_t *path, PSID sid, ACCESS_MODE mode, DWORD mask) {
  HANDLE lock = grants_lock();
  DWORD result;
  if (lock == NULL) return ERROR_TIMEOUT;
  result = change_entry_locked(path, sid, mode, mask);
  grants_unlock(lock);
  return result;
}

static int inheritable_read_present(PACL dacl, PSID sid) {
  ACL_SIZE_INFORMATION size;
  DWORD read = grant_mask(KEIKO_GRANT_READ);
  BYTE inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
  if (dacl == NULL || !GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation)) return 0;
  for (DWORD index = 0; index < size.AceCount; index++) {
    ACCESS_ALLOWED_ACE *ace = NULL;
    if (!GetAce(dacl, index, (LPVOID *)&ace) || ace == NULL) return 0;
    if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
        (ace->Header.AceFlags & inherit) == inherit &&
        (ace->Header.AceFlags & INHERIT_ONLY_ACE) == 0 && (ace->Mask & read) == read &&
        EqualSid((PSID)&ace->SidStart, sid))
      return 1;
  }
  return 0;
}

typedef BOOL(WINAPI *derive_capability_sids)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);

/* Resolved from the already loaded kernelbase.dll: only the umbrella import libraries export it,
 * and linking one of them would replace the supervisor's ordinary system imports. */
static derive_capability_sids capability_deriver(void) {
  HMODULE kernelbase = GetModuleHandleW(L"kernelbase.dll");
  FARPROC procedure =
      kernelbase == NULL ? NULL : GetProcAddress(kernelbase, "DeriveCapabilitySidsFromName");
  derive_capability_sids derive = NULL;
  if (procedure != NULL) memcpy(&derive, &procedure, sizeof(derive));
  return derive;
}

static PSID derive_capability(const wchar_t *name) {
  PSID *groups = NULL, *capabilities = NULL, copy = NULL;
  DWORD group_count = 0, capability_count = 0;
  derive_capability_sids derive = capability_deriver();
  if (derive == NULL ||
      !derive(name, &groups, &group_count, &capabilities, &capability_count))
    return NULL;
  if (capability_count >= 1 && capabilities != NULL && IsValidSid(capabilities[0])) {
    DWORD length = GetLengthSid(capabilities[0]);
    copy = LocalAlloc(LMEM_FIXED, length);
    if (copy != NULL && !CopySid(length, copy, capabilities[0])) {
      LocalFree(copy);
      copy = NULL;
    }
  }
  for (DWORD index = 0; groups != NULL && index < group_count; index++) LocalFree(groups[index]);
  for (DWORD index = 0; capabilities != NULL && index < capability_count; index++)
    LocalFree(capabilities[index]);
  LocalFree(groups);
  LocalFree(capabilities);
  return copy;
}

/* Granted once per worktree and kept: setting an inheritable entry walks the existing tree, which a
 * per-run grant would repeat twice for every run. */
static int ensure_capability(struct keiko_gateway_grant *grant) {
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  int present;
  grant->capability_sid = derive_capability(grant->capability);
  if (grant->capability_sid == NULL) return 0;
  if (GetNamedSecurityInfoW(grant->path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                            &dacl, NULL, &descriptor) != ERROR_SUCCESS)
    return 0;
  present = inheritable_read_present(dacl, grant->capability_sid);
  LocalFree(descriptor);
  return present || change_entry(grant->path, grant->capability_sid, GRANT_ACCESS,
                                 grant_mask(KEIKO_GRANT_READ)) == ERROR_SUCCESS;
}

static int apply_entry(struct keiko_gateway_grants *grants, struct keiko_gateway_grant *grant,
                       PSID tree) {
  if (!plain_directory(grant->path)) return KEIKO_GRANTS_REFUSED_DIRECTORY;
  if (grant->principal == KEIKO_GRANT_TREE) {
    if (change_entry(grant->path, tree, GRANT_ACCESS, grant_mask(grant->access)) != ERROR_SUCCESS)
      return KEIKO_GRANTS_REFUSED_ACL;
    grant->applied = 1;
    return KEIKO_GRANTS_APPLIED;
  }
  if (!ensure_capability(grant)) return KEIKO_GRANTS_REFUSED_CAPABILITY;
  grants->capabilities[grants->capability_count].Sid = grant->capability_sid;
  grants->capabilities[grants->capability_count].Attributes = SE_GROUP_ENABLED;
  grants->capability_count++;
  return KEIKO_GRANTS_APPLIED;
}

int keiko_gateway_grants_apply(_Inout_ struct keiko_gateway_grants *grants, PSID tree) {
  if (tree == NULL || !IsValidSid(tree)) return KEIKO_GRANTS_REFUSED_ACL;
  grants->capability_count = 0;
  for (size_t index = 0; index < grants->count; index++) {
    int refused = apply_entry(grants, &grants->entries[index], tree);
    if (refused != KEIKO_GRANTS_APPLIED) {
      keiko_gateway_grants_revoke(grants, tree);
      grants->capability_count = 0;
      return refused;
    }
  }
  return KEIKO_GRANTS_APPLIED;
}

/* An AppContainer package SID: S-1-15-2 and seven sub-authorities. The well-known package groups
 * (S-1-15-2-1, S-1-15-2-2) and capability SIDs (S-1-15-3) never match. */
static int package_sid(PSID sid) {
  SID_IDENTIFIER_AUTHORITY app = SECURITY_APP_PACKAGE_AUTHORITY;
  PSID_IDENTIFIER_AUTHORITY authority;
  if (sid == NULL || !IsValidSid(sid)) return 0;
  authority = GetSidIdentifierAuthority(sid);
  return memcmp(authority, &app, sizeof(app)) == 0 &&
         *GetSidSubAuthorityCount(sid) == SECURITY_APP_PACKAGE_RID_COUNT &&
         *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

/* Exactly the entry change_entry writes for a tree grant: explicit, inheritable to files and
 * directories, and one of the two tree masks. */
static int stale_tree_entry(const ACCESS_ALLOWED_ACE *ace) {
  BYTE inherit = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
  return ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == inherit &&
         (ace->Mask == grant_mask(KEIKO_GRANT_READ) ||
          ace->Mask == grant_mask(KEIKO_GRANT_MODIFY)) &&
         package_sid((PSID)&ace->SidStart);
}

static void sids_free(PSID *sids, DWORD count) {
  for (DWORD index = 0; index < count; index++) LocalFree(sids[index]);
}

/* Copies the stale entries' SIDs first: each revoke rewrites the DACL being read. */
static DWORD stale_sids(const wchar_t *path, PSID sids[KEIKO_GATEWAY_SWEEP_MAX], DWORD *count) {
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  ACL_SIZE_INFORMATION size = {0};
  DWORD result = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                                       &dacl, NULL, &descriptor);
  *count = 0;
  if (result != ERROR_SUCCESS) return result;
  if (dacl != NULL && !GetAclInformation(dacl, &size, sizeof(size), AclSizeInformation))
    result = GetLastError();
  for (DWORD index = 0; result == ERROR_SUCCESS && dacl != NULL && index < size.AceCount &&
                        *count < KEIKO_GATEWAY_SWEEP_MAX;
       index++) {
    ACCESS_ALLOWED_ACE *ace = NULL;
    PSID sid;
    DWORD length;
    if (!GetAce(dacl, index, (LPVOID *)&ace) || ace == NULL) {
      result = GetLastError();
      break;
    }
    if (!stale_tree_entry(ace)) continue;
    length = GetLengthSid((PSID)&ace->SidStart);
    sid = LocalAlloc(LMEM_FIXED, length);
    if (sid == NULL || !CopySid(length, sid, (PSID)&ace->SidStart)) {
      if (sid != NULL) LocalFree(sid);
      result = ERROR_NOT_ENOUGH_MEMORY;
      break;
    }
    sids[(*count)++] = sid;
  }
  LocalFree(descriptor);
  if (result != ERROR_SUCCESS) {
    sids_free(sids, *count);
    *count = 0;
  }
  return result;
}

void keiko_gateway_grants_sweep(_Inout_ void *context) {
  struct keiko_gateway_sweep *sweep = context;
  const struct keiko_gateway_grants *grants = sweep->grants;
  for (size_t index = 0; grants != NULL && index < grants->count; index++) {
    const struct keiko_gateway_grant *grant = &grants->entries[index];
    PSID sids[KEIKO_GATEWAY_SWEEP_MAX] = {0};
    DWORD count = 0;
    if (grant->principal != KEIKO_GRANT_TREE || !plain_directory(grant->path)) continue;
    if (stale_sids(grant->path, sids, &count) != ERROR_SUCCESS) {
      sweep->failed++;
      continue;
    }
    for (DWORD sid = 0; sid < count; sid++) {
      if (change_entry(grant->path, sids[sid], REVOKE_ACCESS, 0) == ERROR_SUCCESS)
        sweep->removed++;
      else
        sweep->failed++;
    }
    sids_free(sids, count);
  }
}

void keiko_gateway_grants_revoke(_Inout_ struct keiko_gateway_grants *grants, PSID tree) {
  for (size_t index = 0; index < grants->count; index++) {
    struct keiko_gateway_grant *grant = &grants->entries[index];
    if (!grant->applied) continue;
    /* Body-free: a stale entry names a SID no later process can obtain. */
    if (change_entry(grant->path, tree, REVOKE_ACCESS, 0) != ERROR_SUCCESS)
      fputs("gateway grant revoke failed\n", stderr);
    grant->applied = 0;
  }
}

/* C6001 is disabled for this function only. Every entry below `count` was zeroed before parsing
 * wrote it, but the analyzer does not track that per-entry initialization through the array and
 * reports each released field as uninitialized, as it does for gateway_loopback.c's update(). */
#pragma warning(push)
#pragma warning(disable : 6001)
void keiko_gateway_grants_clear(_Inout_ struct keiko_gateway_grants *grants) {
  for (size_t index = 0; index < grants->count && index < KEIKO_GATEWAY_GRANTS_MAX; index++) {
    free(grants->entries[index].path);
    free(grants->entries[index].capability);
    if (grants->entries[index].capability_sid != NULL)
      LocalFree(grants->entries[index].capability_sid);
  }
  memset(grants, 0, sizeof(*grants));
}
#pragma warning(pop)

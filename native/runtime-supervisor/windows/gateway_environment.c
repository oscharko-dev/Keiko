/* #4068 W1 (proposal C, decided 2026-11-07: only while a confined run lives). See
 * gateway_environment.h and ADR-0043 D18. The record holds no value of the key, only process ids,
 * creation times and the removed entries' access masks and flags. */
#include "gateway_environment.h"
#include "gateway_user_lock.h"

#include <aclapi.h>
#include <sddl.h>
#include <string.h>

#define RECORD_VALUE L"State"
#define RECORD_HEADER_BYTES 8u
#define REMOVED_BYTES 8u
#define HOLDER_BYTES 12u
#define RECORD_MAX_BYTES                                                                           \
  (RECORD_HEADER_BYTES + KEIKO_ENVIRONMENT_PRINCIPALS * REMOVED_BYTES +                            \
   KEIKO_ENVIRONMENT_HOLDERS_MAX * HOLDER_BYTES)
#define LOCK_WAIT_MS 10000u
#define INHERIT_FLAGS (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)

const struct keiko_environment_target KEIKO_ENVIRONMENT_USER = {
    HKEY_CURRENT_USER, L"CURRENT_USER\\Environment",
    L"Software\\Keiko\\RuntimeSupervisor\\EnvironmentGuard",
    L"KeikoRuntimeSupervisorEnvironmentGuard.lock"};

/* ALL APPLICATION PACKAGES, ALL RESTRICTED APPLICATION PACKAGES and the registryRead capability. */
static const wchar_t *const PRINCIPALS[KEIKO_ENVIRONMENT_PRINCIPALS] = {
    L"S-1-15-2-1", L"S-1-15-2-2",
    L"S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-"
    L"3456934681"};

struct removed_entry {
  DWORD mask;
  BYTE flags;
  BYTE present;
};

struct record {
  struct removed_entry removed[KEIKO_ENVIRONMENT_PRINCIPALS];
  DWORD holder_count;
  struct keiko_environment_holder holders[KEIKO_ENVIRONMENT_HOLDERS_MAX];
};

static void put_u32(BYTE *bytes, DWORD value) {
  bytes[0] = (BYTE)value;
  bytes[1] = (BYTE)(value >> 8);
  bytes[2] = (BYTE)(value >> 16);
  bytes[3] = (BYTE)(value >> 24);
}

static DWORD get_u32(const BYTE *bytes) {
  return (DWORD)bytes[0] | ((DWORD)bytes[1] << 8) | ((DWORD)bytes[2] << 16) |
         ((DWORD)bytes[3] << 24);
}

/* Only a read entry in the shape the key carries is ever recorded or put back. */
static int restorable(const struct removed_entry *entry) {
  if (entry->present == 0) return entry->mask == 0 && entry->flags == 0;
  return entry->present == 1 && entry->mask != 0 && (entry->mask & ~(DWORD)KEY_READ) == 0 &&
         (entry->flags & ~INHERIT_FLAGS) == 0;
}

static DWORD record_encode(const struct record *record, BYTE *bytes) {
  BYTE *at = bytes + RECORD_HEADER_BYTES;
  memcpy(bytes, "KEG1", 4);
  put_u32(bytes + 4, record->holder_count);
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++, at += REMOVED_BYTES) {
    put_u32(at, record->removed[index].mask);
    at[4] = record->removed[index].flags;
    at[5] = record->removed[index].present;
    at[6] = 0;
    at[7] = 0;
  }
  for (DWORD index = 0; index < record->holder_count; index++, at += HOLDER_BYTES) {
    put_u32(at, record->holders[index].pid);
    put_u32(at + 4, record->holders[index].created.dwLowDateTime);
    put_u32(at + 8, record->holders[index].created.dwHighDateTime);
  }
  return (DWORD)(at - bytes);
}

static int record_decode(const BYTE *bytes, DWORD size, struct record *record) {
  const BYTE *at = bytes + RECORD_HEADER_BYTES;
  memset(record, 0, sizeof(*record));
  if (size < RECORD_HEADER_BYTES || memcmp(bytes, "KEG1", 4) != 0) return 0;
  record->holder_count = get_u32(bytes + 4);
  if (record->holder_count > KEIKO_ENVIRONMENT_HOLDERS_MAX ||
      size != RECORD_HEADER_BYTES + KEIKO_ENVIRONMENT_PRINCIPALS * REMOVED_BYTES +
                  record->holder_count * HOLDER_BYTES)
    return 0;
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++, at += REMOVED_BYTES) {
    record->removed[index].mask = get_u32(at);
    record->removed[index].flags = at[4];
    record->removed[index].present = at[5];
    if (at[6] != 0 || at[7] != 0 || !restorable(&record->removed[index])) return 0;
  }
  for (DWORD index = 0; index < record->holder_count; index++, at += HOLDER_BYTES) {
    record->holders[index].pid = get_u32(at);
    record->holders[index].created.dwLowDateTime = get_u32(at + 4);
    record->holders[index].created.dwHighDateTime = get_u32(at + 8);
  }
  return 1;
}

static DWORD record_read(const struct keiko_environment_target *target, struct record *record) {
  BYTE bytes[RECORD_MAX_BYTES];
  DWORD size = sizeof(bytes), type = 0, result;
  memset(record, 0, sizeof(*record));
  /* A missing key or value is no record; a value of another type or size is a corrupt one. */
  result = (DWORD)RegGetValueW(target->root, target->record, RECORD_VALUE, RRF_RT_ANY, &type, bytes,
                               &size);
  if (result == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
  if (result != ERROR_SUCCESS) return result;
  return type == REG_BINARY && record_decode(bytes, size, record) ? ERROR_SUCCESS
                                                                   : ERROR_INVALID_DATA;
}

static int record_empty(const struct record *record) {
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++)
    if (record->removed[index].present) return 0;
  return record->holder_count == 0;
}

/* Durable before the key changes: an empty record is deleted, any other one is flushed. */
static DWORD record_write(const struct keiko_environment_target *target,
                          const struct record *record) {
  BYTE bytes[RECORD_MAX_BYTES];
  DWORD size, result;
  HKEY key = NULL;
  if (record_empty(record)) {
    result = RegDeleteKeyW(target->root, target->record);
    return result == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : result;
  }
  size = record_encode(record, bytes);
  result = RegCreateKeyExW(target->root, target->record, 0, NULL, REG_OPTION_NON_VOLATILE,
                           KEY_SET_VALUE, NULL, &key, NULL);
  if (result != ERROR_SUCCESS) return result;
  result = RegSetValueExW(key, RECORD_VALUE, 0, REG_BINARY, bytes, size);
  if (result == ERROR_SUCCESS) result = RegFlushKey(key);
  RegCloseKey(key);
  return result;
}

static int same_holder(const struct keiko_environment_holder *left,
                       const struct keiko_environment_holder *right) {
  return left->pid == right->pid &&
         left->created.dwLowDateTime == right->created.dwLowDateTime &&
         left->created.dwHighDateTime == right->created.dwHighDateTime;
}

/* A process that cannot be opened for a reason other than its absence counts as alive, so an
 * unproven death never reopens the key. */
static int holder_alive(const struct keiko_environment_holder *holder) {
  FILETIME created, exited, kernel, user;
  DWORD code = 0;
  int alive;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, holder->pid);
  if (process == NULL) return GetLastError() != ERROR_INVALID_PARAMETER;
  alive = !GetProcessTimes(process, &created, &exited, &kernel, &user) ||
          (created.dwLowDateTime == holder->created.dwLowDateTime &&
           created.dwHighDateTime == holder->created.dwHighDateTime &&
           (!GetExitCodeProcess(process, &code) || code == STILL_ACTIVE));
  CloseHandle(process);
  return alive;
}

static void prune(struct record *record, const struct keiko_environment_holder *leaving) {
  DWORD kept = 0;
  for (DWORD index = 0; index < record->holder_count; index++) {
    const struct keiko_environment_holder *holder = &record->holders[index];
    if ((leaving != NULL && same_holder(holder, leaving)) || !holder_alive(holder)) continue;
    record->holders[kept++] = *holder;
  }
  record->holder_count = kept;
}

static DWORD holder_add(struct record *record, const struct keiko_environment_holder *holder) {
  for (DWORD index = 0; index < record->holder_count; index++)
    if (same_holder(&record->holders[index], holder)) return ERROR_SUCCESS;
  if (record->holder_count >= KEIKO_ENVIRONMENT_HOLDERS_MAX) return ERROR_NOT_ENOUGH_QUOTA;
  record->holders[record->holder_count++] = *holder;
  return ERROR_SUCCESS;
}

static void principals_free(PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS]) {
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++) {
    if (principals[index] != NULL) LocalFree(principals[index]);
    principals[index] = NULL;
  }
}

static DWORD principals_load(PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS]) {
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++) {
    if (!ConvertStringSidToSidW(PRINCIPALS[index], &principals[index])) {
      DWORD result = GetLastError();
      principals_free(principals);
      return result;
    }
  }
  return ERROR_SUCCESS;
}

static int principal_index(const ACE_HEADER *header, PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS]) {
  const ACCESS_ALLOWED_ACE *ace = (const ACCESS_ALLOWED_ACE *)header;
  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return -1;
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++)
    if (EqualSid((PSID)&ace->SidStart, principals[index])) return (int)index;
  return -1;
}

struct key_dacl {
  PACL dacl;
  PSECURITY_DESCRIPTOR descriptor;
  int protected_dacl;
};

static void key_dacl_close(struct key_dacl *state) {
  if (state->descriptor != NULL) LocalFree(state->descriptor);
  memset(state, 0, sizeof(*state));
}

/* A key without a DACL grants everyone everything: it is refused, never edited. */
static DWORD key_dacl_open(const struct keiko_environment_target *target, struct key_dacl *state) {
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0, result;
  memset(state, 0, sizeof(*state));
  result = GetNamedSecurityInfoW(target->key, SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, NULL,
                                 NULL, &state->dacl, NULL, &state->descriptor);
  if (result == ERROR_SUCCESS && state->dacl == NULL) result = ERROR_INVALID_SECURITY_DESCR;
  if (result == ERROR_SUCCESS && !GetSecurityDescriptorControl(state->descriptor, &control, &revision))
    result = GetLastError();
  state->protected_dacl = (control & SE_DACL_PROTECTED) != 0;
  if (result != ERROR_SUCCESS) key_dacl_close(state);
  return result;
}

static DWORD key_dacl_set(const struct keiko_environment_target *target,
                          const struct key_dacl *state, PACL dacl) {
  SECURITY_INFORMATION information =
      DACL_SECURITY_INFORMATION | (state->protected_dacl ? PROTECTED_DACL_SECURITY_INFORMATION
                                                         : UNPROTECTED_DACL_SECURITY_INFORMATION);
  return SetNamedSecurityInfoW((LPWSTR)target->key, SE_REGISTRY_KEY, information, NULL, NULL, dacl,
                               NULL);
}

static PACL acl_alloc(PACL source, DWORD extra) {
  ACL_SIZE_INFORMATION size;
  DWORD bytes;
  PACL acl;
  if (!GetAclInformation(source, &size, sizeof(size), AclSizeInformation)) return NULL;
  bytes = size.AclBytesInUse + extra;
  acl = LocalAlloc(LPTR, bytes);
  if (acl != NULL && !InitializeAcl(acl, bytes, source->AclRevision)) {
    LocalFree(acl);
    acl = NULL;
  }
  return acl;
}

/* Records one entry that is about to be removed; a second entry of the same principal must have the
 * same flags, and anything but explicit read is refused. */
static DWORD record_entry(struct removed_entry *entry, const ACE_HEADER *header) {
  const ACCESS_ALLOWED_ACE *ace = (const ACCESS_ALLOWED_ACE *)header;
  BYTE flags = header->AceFlags;
  if ((flags & ~INHERIT_FLAGS) != 0 || (ace->Mask & ~(DWORD)KEY_READ) != 0)
    return ERROR_NOT_SUPPORTED;
  if (entry->present && entry->flags != flags) return ERROR_NOT_SUPPORTED;
  entry->present = 1;
  entry->flags = flags;
  entry->mask |= ace->Mask;
  return ERROR_SUCCESS;
}

static DWORD acl_without(PACL source, PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS],
                         struct record *record, PACL *stripped, int *changed) {
  ACL_SIZE_INFORMATION size;
  DWORD result = ERROR_SUCCESS;
  PACL acl = acl_alloc(source, 0);
  *stripped = NULL;
  *changed = 0;
  if (acl == NULL || !GetAclInformation(source, &size, sizeof(size), AclSizeInformation)) {
    if (acl != NULL) LocalFree(acl);
    return ERROR_NOT_ENOUGH_MEMORY;
  }
  for (DWORD index = 0; index < size.AceCount && result == ERROR_SUCCESS; index++) {
    ACE_HEADER *header = NULL;
    int principal;
    if (!GetAce(source, index, (LPVOID *)&header) || header == NULL) {
      result = ERROR_INVALID_ACL;
      break;
    }
    principal = principal_index(header, principals);
    if (principal >= 0) {
      result = record_entry(&record->removed[principal], header);
      *changed = 1;
    } else if (!AddAce(acl, source->AclRevision, MAXDWORD, header, header->AceSize)) {
      result = GetLastError();
    }
  }
  if (result != ERROR_SUCCESS) {
    LocalFree(acl);
    return result;
  }
  *stripped = acl;
  return ERROR_SUCCESS;
}

static int principal_allowed(PACL acl, PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS],
                             int wanted) {
  ACL_SIZE_INFORMATION size;
  if (!GetAclInformation(acl, &size, sizeof(size), AclSizeInformation)) return 1;
  for (DWORD index = 0; index < size.AceCount; index++) {
    ACE_HEADER *header = NULL;
    int principal;
    if (!GetAce(acl, index, (LPVOID *)&header) || header == NULL) return 1;
    principal = principal_index(header, principals);
    if (principal >= 0 && (wanted < 0 || principal == wanted)) return 1;
  }
  return 0;
}

static DWORD acl_with(PACL source, PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS],
                      const struct record *record, PACL *restored) {
  ACL_SIZE_INFORMATION size;
  DWORD extra = 0;
  PACL acl;
  *restored = NULL;
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++)
    extra += sizeof(ACCESS_ALLOWED_ACE) + GetLengthSid(principals[index]);
  acl = acl_alloc(source, extra);
  if (acl == NULL || !GetAclInformation(source, &size, sizeof(size), AclSizeInformation)) {
    if (acl != NULL) LocalFree(acl);
    return ERROR_NOT_ENOUGH_MEMORY;
  }
  for (DWORD index = 0; index < size.AceCount; index++) {
    ACE_HEADER *header = NULL;
    if (!GetAce(source, index, (LPVOID *)&header) || header == NULL ||
        !AddAce(acl, source->AclRevision, MAXDWORD, header, header->AceSize)) {
      LocalFree(acl);
      return ERROR_INVALID_ACL;
    }
  }
  /* Appended in principal order, the order the key carried them in; one already present again
   * (put back by the user) is not duplicated. */
  for (DWORD index = 0; index < KEIKO_ENVIRONMENT_PRINCIPALS; index++) {
    const struct removed_entry *entry = &record->removed[index];
    if (!entry->present || principal_allowed(source, principals, (int)index)) continue;
    if (!restorable(entry) ||
        !AddAccessAllowedAceEx(acl, ACL_REVISION, entry->flags, entry->mask, principals[index])) {
      LocalFree(acl);
      return ERROR_INVALID_DATA;
    }
  }
  *restored = acl;
  return ERROR_SUCCESS;
}

static DWORD verify_closed(const struct keiko_environment_target *target,
                           PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS]) {
  struct key_dacl state;
  DWORD result = key_dacl_open(target, &state);
  if (result == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
  if (result != ERROR_SUCCESS) return result;
  result = principal_allowed(state.dacl, principals, -1) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  key_dacl_close(&state);
  return result;
}

/* The holder and the removed entries are durable before the key changes. */
static DWORD close_key(const struct keiko_environment_target *target,
                       PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS], struct record *record) {
  struct key_dacl state;
  PACL stripped = NULL;
  int changed = 0;
  DWORD result = key_dacl_open(target, &state);
  if (result == ERROR_FILE_NOT_FOUND) return record_write(target, record);
  if (result != ERROR_SUCCESS) return result;
  result = acl_without(state.dacl, principals, record, &stripped, &changed);
  if (result == ERROR_SUCCESS) result = record_write(target, record);
  if (result == ERROR_SUCCESS && changed) result = key_dacl_set(target, &state, stripped);
  if (stripped != NULL) LocalFree(stripped);
  key_dacl_close(&state);
  return result == ERROR_SUCCESS ? verify_closed(target, principals) : result;
}

static DWORD reopen_key(const struct keiko_environment_target *target,
                        PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS], struct record *record) {
  struct key_dacl state;
  PACL restored = NULL;
  DWORD result = key_dacl_open(target, &state);
  if (result == ERROR_FILE_NOT_FOUND) {
    memset(record->removed, 0, sizeof(record->removed));
    return ERROR_SUCCESS;
  }
  if (result != ERROR_SUCCESS) return result;
  result = acl_with(state.dacl, principals, record, &restored);
  if (result == ERROR_SUCCESS) result = key_dacl_set(target, &state, restored);
  if (restored != NULL) LocalFree(restored);
  key_dacl_close(&state);
  if (result == ERROR_SUCCESS) memset(record->removed, 0, sizeof(record->removed));
  return result;
}

static DWORD reopen_locked(const struct keiko_environment_target *target,
                           PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS],
                           const struct keiko_environment_holder *holder) {
  struct record record;
  DWORD result = record_read(target, &record), written;
  if (result != ERROR_SUCCESS) return result;
  prune(&record, holder);
  if (record.holder_count == 0 && !record_empty(&record))
    result = reopen_key(target, principals, &record);
  /* A failed restore keeps the removed entries, so the next close or reopen retries it. */
  written = record_write(target, &record);
  return result != ERROR_SUCCESS ? result : written;
}

/* The record is per-user state shared by every logon session of the user, so its lock is the
 * cross-session per-user file lock; a holder that died releases it with its handle (#4242). */
static HANDLE lock_take(const wchar_t *leaf, DWORD *result) {
  return keiko_user_lock_take(leaf, LOCK_WAIT_MS, result);
}

static void lock_drop(HANDLE lock) {
  keiko_user_lock_drop(lock);
}

static int valid_holder(const struct keiko_environment_holder *holder) {
  return holder != NULL && holder->pid != 0 &&
         (holder->created.dwLowDateTime != 0 || holder->created.dwHighDateTime != 0);
}

int keiko_environment_holder_self(_Out_ struct keiko_environment_holder *holder) {
  FILETIME exited, kernel, user;
  memset(holder, 0, sizeof(*holder));
  holder->pid = GetCurrentProcessId();
  return GetProcessTimes(GetCurrentProcess(), &holder->created, &exited, &kernel, &user) &&
         valid_holder(holder);
}

DWORD keiko_environment_close(_In_ const struct keiko_environment_target *target,
                              _In_ const struct keiko_environment_holder *holder) {
  return keiko_environment_close_alone(target, holder, NULL, NULL);
}

DWORD keiko_environment_close_alone(_In_ const struct keiko_environment_target *target,
                                    _In_ const struct keiko_environment_holder *holder,
                                    _In_opt_ keiko_environment_alone alone,
                                    _Inout_opt_ void *context) {
  PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS] = {0};
  struct record record;
  DWORD result = ERROR_SUCCESS;
  HANDLE lock;
  if (!valid_holder(holder)) return ERROR_INVALID_PARAMETER;
  lock = lock_take(target->lock, &result);
  if (lock == NULL) return result;
  result = principals_load(principals);
  if (result == ERROR_SUCCESS) {
    result = record_read(target, &record);
    /* A record that cannot be read is never rewritten: it is the only statement of what to put
     * back, so the launch is refused and the key is left as it is. */
    if (result == ERROR_SUCCESS) {
      prune(&record, NULL);
      if (record.holder_count == 0 && alone != NULL && context != NULL) alone(context);
      result = holder_add(&record, holder);
      if (result == ERROR_SUCCESS) result = close_key(target, principals, &record);
      if (result != ERROR_SUCCESS) (void)reopen_locked(target, principals, holder);
    }
    principals_free(principals);
  }
  lock_drop(lock);
  return result;
}

DWORD keiko_environment_reopen(_In_ const struct keiko_environment_target *target,
                               _In_ const struct keiko_environment_holder *holder) {
  PSID principals[KEIKO_ENVIRONMENT_PRINCIPALS] = {0};
  DWORD result = ERROR_SUCCESS;
  HANDLE lock;
  if (!valid_holder(holder)) return ERROR_INVALID_PARAMETER;
  lock = lock_take(target->lock, &result);
  if (lock == NULL) return result;
  result = principals_load(principals);
  if (result == ERROR_SUCCESS) {
    result = reopen_locked(target, principals, holder);
    principals_free(principals);
  }
  lock_drop(lock);
  return result;
}

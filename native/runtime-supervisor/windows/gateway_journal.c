#include "gateway_journal.h"
#include <string.h>

_Static_assert(SECURITY_MAX_SID_SIZE == 68 && sizeof(GUID) == 16, "KGR1 layout requires Windows SID/GUID sizes");

static int recovery_name(const char *value, wchar_t name[33]) {
  size_t index;
  if (value == NULL) return 0;
  for (index = 0; index < 32; index++) {
    char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return 0;
    name[index] = (wchar_t)byte;
  }
  name[32] = L'\0';
  return value[32] == '\0';
}

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

static int all_zero(const BYTE *bytes, size_t size) {
  size_t index;
  for (index = 0; index < size; index++) if (bytes[index] != 0) return 0;
  return 1;
}

static int bounded_sid(const BYTE *bytes, DWORD size, int package) {
  const SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  /* Bound the SID's internal count before IsValidSid/GetLengthSid can inspect its extent. */
  if (size < 8 || size > SECURITY_MAX_SID_SIZE || bytes[1] > SID_MAX_SUB_AUTHORITIES ||
      size != 8u + 4u * (DWORD)bytes[1] || !IsValidSid((PSID)bytes) ||
      GetLengthSid((PSID)bytes) != size ||
      !all_zero(bytes + size, SECURITY_MAX_SID_SIZE - size)) return 0;
  if (!package) return 1;
  return memcmp(GetSidIdentifierAuthority((PSID)bytes), &authority, sizeof(authority)) == 0 &&
         *GetSidSubAuthorityCount((PSID)bytes) == SECURITY_APP_PACKAGE_RID_COUNT &&
         *GetSidSubAuthority((PSID)bytes, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

static int valid_record(const struct keiko_gateway_record *record) {
  wchar_t name[33];
  if (record == NULL || !recovery_name(record->recovery_handle, name) || record->client_pid == 0 ||
      (record->client_created.dwLowDateTime == 0 && record->client_created.dwHighDateTime == 0) ||
      !bounded_sid(record->owner, record->owner_bytes, 0) ||
      !bounded_sid(record->package, record->package_bytes, 1) ||
      all_zero(record->tree_binding, sizeof(record->tree_binding)) ||
      all_zero(record->policy_digest, sizeof(record->policy_digest))) return 0;
  return keiko_gateway_guard_keys_valid(&record->keys);
}

DWORD keiko_gateway_record_encode(const struct keiko_gateway_record *record,
                                  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES]) {
  if (bytes == NULL || !valid_record(record)) return ERROR_INVALID_DATA;
  /* Fixed little-endian layout; no compiler padding, pointer or handle crosses the boundary. */
  memset(bytes, 0, KEIKO_GATEWAY_RECORD_BYTES);
  memcpy(bytes, "KGR1", 4);
  put_u32(bytes + 4, 1);
  memcpy(bytes + 8, record->recovery_handle, 32);
  put_u32(bytes + 40, record->client_pid);
  put_u32(bytes + 44, record->client_created.dwLowDateTime);
  put_u32(bytes + 48, record->client_created.dwHighDateTime);
  put_u32(bytes + 52, record->owner_bytes);
  memcpy(bytes + 56, record->owner, SECURITY_MAX_SID_SIZE);
  put_u32(bytes + 124, record->package_bytes);
  memcpy(bytes + 128, record->package, SECURITY_MAX_SID_SIZE);
  memcpy(bytes + 196, &record->keys.sublayer, sizeof(GUID));
  memcpy(bytes + 212, record->keys.deny, sizeof(record->keys.deny));
  memcpy(bytes + 244, record->tree_binding, 32);
  memcpy(bytes + 276, record->policy_digest, 32);
  return ERROR_SUCCESS;
}

DWORD keiko_gateway_record_decode(const BYTE *bytes, DWORD size,
                                  struct keiko_gateway_record *record) {
  struct keiko_gateway_record decoded = {0};
  if (bytes == NULL || record == NULL || size != KEIKO_GATEWAY_RECORD_BYTES ||
      memcmp(bytes, "KGR1", 4) != 0 || get_u32(bytes + 4) != 1 ||
      !all_zero(bytes + 308, KEIKO_GATEWAY_RECORD_BYTES - 308)) return ERROR_INVALID_DATA;
  memcpy(decoded.recovery_handle, bytes + 8, 32);
  decoded.client_pid = get_u32(bytes + 40);
  decoded.client_created.dwLowDateTime = get_u32(bytes + 44);
  decoded.client_created.dwHighDateTime = get_u32(bytes + 48);
  decoded.owner_bytes = get_u32(bytes + 52);
  memcpy(decoded.owner, bytes + 56, SECURITY_MAX_SID_SIZE);
  decoded.package_bytes = get_u32(bytes + 124);
  memcpy(decoded.package, bytes + 128, SECURITY_MAX_SID_SIZE);
  memcpy(&decoded.keys.sublayer, bytes + 196, sizeof(GUID));
  memcpy(decoded.keys.deny, bytes + 212, sizeof(decoded.keys.deny));
  memcpy(decoded.tree_binding, bytes + 244, 32);
  memcpy(decoded.policy_digest, bytes + 276, 32);
  if (!valid_record(&decoded)) return ERROR_INVALID_DATA;
  *record = decoded;
  return ERROR_SUCCESS;
}

DWORD keiko_gateway_journal_create(HKEY root, const struct keiko_gateway_record *record) {
  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES];
  wchar_t name[33];
  HKEY key = NULL;
  DWORD disposition = 0, count = 0, result;
  result = keiko_gateway_record_encode(record, bytes);
  if (result != ERROR_SUCCESS || !recovery_name(record->recovery_handle, name)) return result;
  result = (DWORD)RegQueryInfoKeyW(root, NULL, NULL, NULL, &count, NULL, NULL,
                                 NULL, NULL, NULL, NULL, NULL);
  if (result != ERROR_SUCCESS) return result;
  if (count >= KEIKO_GATEWAY_JOURNAL_MAX_RECORDS) return ERROR_NOT_ENOUGH_QUOTA;
  /* The service serializes create/remove operations at this root. Never accept an existing key,
   * including a partial write left by a crash. Recovery/repair must resolve that first. */
  result = (DWORD)RegCreateKeyExW(root, name, 0, NULL, 0, KEY_SET_VALUE | KEY_QUERY_VALUE,
                                NULL, &key, &disposition);
  if (result != ERROR_SUCCESS) return result;
  if (disposition != REG_CREATED_NEW_KEY) result = ERROR_ALREADY_EXISTS;
  else result = (DWORD)RegSetValueExW(key, L"Record", 0, REG_BINARY, bytes, sizeof(bytes));
  if (result == ERROR_SUCCESS) result = (DWORD)RegFlushKey(key);
  RegCloseKey(key);
  SecureZeroMemory(bytes, sizeof(bytes));
  return result;
}

DWORD keiko_gateway_journal_read(HKEY root, const char *recovery_handle,
                                 struct keiko_gateway_record *record) {
  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES];
  wchar_t name[33];
  DWORD size = sizeof(bytes), type = 0, result;
  struct keiko_gateway_record decoded = {0};
  if (record == NULL || !recovery_name(recovery_handle, name)) return ERROR_INVALID_PARAMETER;
  result = (DWORD)RegGetValueW(root, name, L"Record", RRF_RT_REG_BINARY | RRF_ZEROONFAILURE,
                              &type, bytes, &size);
  if (result == ERROR_UNSUPPORTED_TYPE) result = ERROR_INVALID_DATA;
  if (result == ERROR_SUCCESS && type != REG_BINARY) result = ERROR_INVALID_DATA;
  if (result == ERROR_SUCCESS) result = keiko_gateway_record_decode(bytes, size, &decoded);
  if (result == ERROR_SUCCESS && strcmp(decoded.recovery_handle, recovery_handle) != 0)
    result = ERROR_INVALID_DATA;
  SecureZeroMemory(bytes, sizeof(bytes));
  if (result == ERROR_SUCCESS) *record = decoded;
  return result;
}

DWORD keiko_gateway_journal_remove(HKEY root, const char *recovery_handle) {
  wchar_t name[33];
  DWORD result;
  if (!recovery_name(recovery_handle, name)) return ERROR_INVALID_PARAMETER;
  /* Delete the exact leaf only. Unexpected nested state fails rather than recursively deleting. */
  result = (DWORD)RegDeleteKeyW(root, name);
  if (result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND) return result;
  return (DWORD)RegFlushKey(root);
}

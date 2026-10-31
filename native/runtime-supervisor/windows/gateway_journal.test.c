/* No service installation or WFP calls. Registry I/O is confined to a new HKCU fixture key. */
#include "gateway_journal.h"
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <string.h>

static int fixture_record(struct keiko_gateway_record *record) {
  PSID owner = NULL, package = NULL;
  FILETIME exited, kernel, user;
  int ok = 0;
  memset(record, 0, sizeof(*record));
  if (!ConvertStringSidToSidW(L"S-1-5-21-11-22-33-1001", &owner) ||
      !ConvertStringSidToSidW(L"S-1-15-2-11-22-33-44-55-66-77", &package)) goto done;
  memcpy(record->recovery_handle, "0123456789abcdef0123456789abcdef", 32);
  record->client_pid = GetCurrentProcessId();
  if (!GetProcessTimes(GetCurrentProcess(), &record->client_created, &exited, &kernel, &user)) goto done;
  record->owner_bytes = GetLengthSid(owner);
  record->package_bytes = GetLengthSid(package);
  if (!CopySid(sizeof(record->owner), record->owner, owner) ||
      !CopySid(sizeof(record->package), record->package, package) ||
      keiko_gateway_guard_prepare(&record->keys) != ERROR_SUCCESS) goto done;
  memset(record->tree_binding, 0x31, sizeof(record->tree_binding));
  memset(record->policy_digest, 0x42, sizeof(record->policy_digest));
  ok = 1;
done:
  if (owner != NULL) LocalFree(owner);
  if (package != NULL) LocalFree(package);
  return ok;
}

static int record_tests(const struct keiko_gateway_record *record) {
  struct keiko_gateway_record decoded = {0};
  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES], restored[KEIKO_GATEWAY_RECORD_BYTES];
  const size_t invalid_offsets[] = {0, 4, 8, 52, 57, 124, 129, 308, 319};
  size_t index;
  int ok = keiko_gateway_record_encode(record, bytes) == ERROR_SUCCESS &&
           keiko_gateway_record_decode(bytes, sizeof(bytes), &decoded) == ERROR_SUCCESS &&
           keiko_gateway_record_encode(&decoded, restored) == ERROR_SUCCESS &&
           memcmp(bytes, restored, sizeof(bytes)) == 0;
  for (index = 0; index < sizeof(invalid_offsets) / sizeof(invalid_offsets[0]); index++) {
    memcpy(restored, bytes, sizeof(bytes));
    restored[invalid_offsets[index]] = 0xff;
    ok = ok && keiko_gateway_record_decode(restored, sizeof(restored), &decoded) == ERROR_INVALID_DATA;
  }
  for (index = 0; index < sizeof(bytes); index++)
    ok = ok && keiko_gateway_record_decode(bytes, (DWORD)index, &decoded) == ERROR_INVALID_DATA;
  ok = ok && keiko_gateway_record_decode(bytes, sizeof(bytes) + 1, &decoded) == ERROR_INVALID_DATA &&
       keiko_gateway_record_encode(NULL, bytes) == ERROR_INVALID_DATA;
  return ok;
}

static int registry_tests(HKEY root, const struct keiko_gateway_record *record) {
  const wchar_t *name = L"0123456789abcdef0123456789abcdef";
  struct keiko_gateway_record decoded = {0}, changed = *record;
  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES];
  HKEY key = NULL, nested = NULL;
  DWORD disposition = 0;
  int ok = keiko_gateway_journal_create(root, record) == ERROR_SUCCESS;
  changed.policy_digest[0] ^= 1;
  ok = ok && keiko_gateway_journal_create(root, &changed) == ERROR_ALREADY_EXISTS &&
       keiko_gateway_journal_read(root, record->recovery_handle, &decoded) == ERROR_SUCCESS &&
       memcmp(decoded.policy_digest, record->policy_digest, 32) == 0 &&
       keiko_gateway_journal_read(root, "../escape", &decoded) == ERROR_INVALID_PARAMETER &&
       keiko_gateway_journal_remove(root, "../escape") == ERROR_INVALID_PARAMETER;
  if (RegCreateKeyExW(root, name, 0, NULL, 0, KEY_ALL_ACCESS, NULL, &key, &disposition) != ERROR_SUCCESS)
    return 0;
  ok = ok && disposition == REG_OPENED_EXISTING_KEY;
  ok = ok && keiko_gateway_record_encode(record, bytes) == ERROR_SUCCESS;
  /* A well-formed record under another tree's key is corruption, not that tree's authority. */
  bytes[8] = 'f';
  ok = ok && RegSetValueExW(key, L"Record", 0, REG_BINARY, bytes, sizeof(bytes)) == ERROR_SUCCESS &&
       keiko_gateway_journal_read(root, record->recovery_handle, &decoded) == ERROR_INVALID_DATA;
  ok = ok && RegSetValueExW(key, L"Record", 0, REG_SZ, bytes, sizeof(bytes)) == ERROR_SUCCESS &&
       keiko_gateway_journal_read(root, record->recovery_handle, &decoded) == ERROR_INVALID_DATA;
  ok = ok && RegDeleteValueW(key, L"Record") == ERROR_SUCCESS &&
       keiko_gateway_journal_create(root, record) == ERROR_ALREADY_EXISTS &&
       keiko_gateway_journal_read(root, record->recovery_handle, &decoded) == ERROR_FILE_NOT_FOUND;
  /* Never recursively erase unexpected nested state. */
  if (RegCreateKeyExW(key, L"Unexpected", 0, NULL, 0, KEY_ALL_ACCESS, NULL, &nested, NULL) != ERROR_SUCCESS)
    ok = 0;
  else {
    RegCloseKey(nested);
    ok = ok && keiko_gateway_journal_remove(root, record->recovery_handle) != ERROR_SUCCESS;
    if (RegDeleteKeyW(key, L"Unexpected") != ERROR_SUCCESS) ok = 0;
  }
  RegCloseKey(key);
  ok = ok && keiko_gateway_journal_remove(root, record->recovery_handle) == ERROR_SUCCESS &&
       keiko_gateway_journal_remove(root, record->recovery_handle) == ERROR_SUCCESS;
  return ok;
}

int gateway_journal_tests(void) {
  struct keiko_gateway_record record = {0};
  wchar_t name[96];
  UUID id;
  RPC_WSTR text = NULL;
  HKEY root = NULL;
  DWORD disposition = 0;
  int ok = fixture_record(&record);
  if (!ok || !record_tests(&record)) return 1;
  if (UuidCreate(&id) != RPC_S_OK || UuidToStringW(&id, &text) != RPC_S_OK) return 1;
  ok = _snwprintf_s(name, sizeof(name) / sizeof(name[0]), _TRUNCATE,
                    L"Software\\KeikoGatewayFixture-%ls", text) > 0;
  RpcStringFreeW(&text);
  if (!ok || RegCreateKeyExW(HKEY_CURRENT_USER, name, 0, NULL, 0, KEY_ALL_ACCESS,
                             NULL, &root, &disposition) != ERROR_SUCCESS) return 1;
  if (disposition != REG_CREATED_NEW_KEY) { RegCloseKey(root); return 1; }
  ok = registry_tests(root, &record);
  /* Known fixture leaves only; no recursive cleanup can hide an unexpected registry subtree. */
  (void)RegDeleteKeyW(root, L"0123456789abcdef0123456789abcdef\\Unexpected");
  (void)RegDeleteKeyW(root, L"0123456789abcdef0123456789abcdef");
  RegCloseKey(root);
  if (RegDeleteKeyW(HKEY_CURRENT_USER, name) != ERROR_SUCCESS) ok = 0;
  puts(ok ? "gateway-recovery-journal: passed" : "gateway-recovery-journal: failed");
  return ok ? 0 : 1;
}

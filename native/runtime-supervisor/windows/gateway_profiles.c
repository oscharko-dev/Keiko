/* #4495: the per-run AppContainer profiles of confined launches, and the session they need. */
#include "gateway_profiles.h"

#include <userenv.h>
#include <string.h>
#include <wchar.h>
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "userenv.lib")

#define PID_DIGITS 8u
#define CREATED_DIGITS 16u
#define RANDOM_DIGITS (2u * KEIKO_PROFILE_RANDOM_BYTES)
#define SUFFIX_CHARS (PID_DIGITS + 1u + CREATED_DIGITS + 1u + RANDOM_DIGITS)
/* Where Windows records each AppContainer profile of this user, by SID, with its name. */
#define PROFILE_MAPPINGS                                                                           \
  L"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"             \
  L"AppContainer\\Mappings"
#define MAPPING_INDEX_MAX 65536u
#define SID_CHARS 256u

static const wchar_t *const PREFIXES[] = {KEIKO_PROFILE_PREFIX_RELAY, KEIKO_PROFILE_PREFIX_STEP};

/* The rest of `name` after a Keiko prefix; Windows keeps profile names case-insensitively. */
static const wchar_t *after_prefix(const wchar_t *name) {
  for (size_t index = 0; index < sizeof(PREFIXES) / sizeof(PREFIXES[0]); index++) {
    size_t length = wcslen(PREFIXES[index]);
    if (_wcsnicmp(name, PREFIXES[index], length) == 0) return name + length;
  }
  return NULL;
}

static int parse_hex(const wchar_t *digits, size_t count, ULONGLONG *value) {
  *value = 0;
  for (size_t index = 0; index < count; index++) {
    wchar_t digit = digits[index];
    ULONGLONG nibble;
    if (digit >= L'0' && digit <= L'9') nibble = (ULONGLONG)(digit - L'0');
    else if (digit >= L'a' && digit <= L'f') nibble = (ULONGLONG)(digit - L'a' + 10);
    else if (digit >= L'A' && digit <= L'F') nibble = (ULONGLONG)(digit - L'A' + 10);
    else return 0;
    *value = (*value << 4) | nibble;
  }
  return 1;
}

int keiko_profile_name(_In_z_ const wchar_t *prefix,
                       _In_ const struct keiko_environment_holder *owner,
                       _In_reads_(KEIKO_PROFILE_RANDOM_BYTES) const BYTE *random,
                       _Out_writes_z_(KEIKO_PROFILE_NAME_CHARS) wchar_t *name) {
  static const wchar_t hex[] = L"0123456789abcdef";
  wchar_t digits[RANDOM_DIGITS + 1];
  const wchar_t *rest = after_prefix(prefix);
  name[0] = L'\0';
  if (rest == NULL || *rest != L'\0') return 0;
  for (size_t index = 0; index < KEIKO_PROFILE_RANDOM_BYTES; index++) {
    digits[2 * index] = hex[random[index] >> 4];
    digits[2 * index + 1] = hex[random[index] & 15];
  }
  digits[RANDOM_DIGITS] = L'\0';
  return _snwprintf_s(name, KEIKO_PROFILE_NAME_CHARS, _TRUNCATE, L"%ls%08lx-%08lx%08lx-%ls", prefix,
                      (unsigned long)owner->pid, (unsigned long)owner->created.dwHighDateTime,
                      (unsigned long)owner->created.dwLowDateTime, digits) > 0;
}

int keiko_profile_owner(_In_z_ const wchar_t *name, _Out_ struct keiko_environment_holder *owner) {
  const wchar_t *suffix = after_prefix(name);
  ULONGLONG pid = 0, created = 0, random = 0;
  memset(owner, 0, sizeof(*owner));
  if (suffix == NULL || wcslen(suffix) != SUFFIX_CHARS || suffix[PID_DIGITS] != L'-' ||
      suffix[PID_DIGITS + 1 + CREATED_DIGITS] != L'-' || !parse_hex(suffix, PID_DIGITS, &pid) ||
      !parse_hex(suffix + PID_DIGITS + 1, CREATED_DIGITS, &created) ||
      !parse_hex(suffix + PID_DIGITS + 2 + CREATED_DIGITS, RANDOM_DIGITS, &random) || pid == 0 ||
      created == 0)
    return 0;
  owner->pid = (DWORD)pid;
  owner->created.dwHighDateTime = (DWORD)(created >> 32);
  owner->created.dwLowDateTime = (DWORD)created;
  return 1;
}

int keiko_profile_stale(_In_z_ const wchar_t *name, _In_ keiko_profile_alive alive) {
  struct keiko_environment_holder owner;
  return keiko_profile_owner(name, &owner) && !alive(&owner);
}

/* Collects first and deletes afterwards: a deletion renumbers the keys being enumerated. */
static DWORD stale_profiles(wchar_t (*stale)[KEIKO_PROFILE_NAME_CHARS]) {
  HKEY mappings;
  DWORD count = 0;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, PROFILE_MAPPINGS, 0, KEY_READ, &mappings) != ERROR_SUCCESS)
    return 0;
  for (DWORD index = 0; index < MAPPING_INDEX_MAX && count < KEIKO_PROFILE_SWEEP_MAX; index++) {
    wchar_t sid[SID_CHARS], moniker[KEIKO_PROFILE_NAME_CHARS];
    DWORD sid_chars = SID_CHARS, bytes = sizeof(moniker);
    LSTATUS status = RegEnumKeyExW(mappings, index, sid, &sid_chars, NULL, NULL, NULL, NULL);
    if (status == ERROR_NO_MORE_ITEMS) break;
    /* A name longer than any Keiko profile's is foreign and skipped. */
    if (status == ERROR_SUCCESS &&
        RegGetValueW(mappings, sid, L"Moniker", RRF_RT_REG_SZ, NULL, moniker, &bytes) ==
            ERROR_SUCCESS &&
        keiko_profile_stale(moniker, keiko_environment_holder_alive))
      wcscpy_s(stale[count++], KEIKO_PROFILE_NAME_CHARS, moniker);
  }
  RegCloseKey(mappings);
  return count;
}

void keiko_profiles_sweep(_Out_ struct keiko_profile_sweep *sweep) {
  static wchar_t stale[KEIKO_PROFILE_SWEEP_MAX][KEIKO_PROFILE_NAME_CHARS];
  DWORD count = stale_profiles(stale);
  memset(sweep, 0, sizeof(*sweep));
  for (DWORD index = 0; index < count; index++) {
    if (SUCCEEDED(DeleteAppContainerProfile(stale[index]))) sweep->removed++;
    else sweep->failed++;
  }
}

int keiko_window_station_interactive(_In_z_ const wchar_t *name) {
  return _wcsicmp(name, L"WinSta0") == 0;
}

int keiko_session_interactive(void) {
  wchar_t name[64] = {0};
  DWORD needed = 0;
  HWINSTA station = GetProcessWindowStation();
  return station != NULL &&
         GetUserObjectInformationW(station, UOI_NAME, name, sizeof(name) - sizeof(wchar_t),
                                   &needed) &&
         keiko_window_station_interactive(name);
}

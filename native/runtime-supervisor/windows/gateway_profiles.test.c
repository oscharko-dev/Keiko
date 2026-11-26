/* #4495: the per-run AppContainer profile names, the stale-profile sweep and the session check.
 * Needs no administrator rights: the sweep test creates its own profiles for this user and deletes
 * every one it made. */
#include "gateway_profiles.h"

#include <bcrypt.h>
#include <sddl.h>
#include <stdio.h>
#include <string.h>
#include <userenv.h>
#include <wchar.h>
#pragma comment(lib, "bcrypt.lib")

static int failures = 0;

static void check(int condition, const char *name) {
  if (!condition) {
    fprintf(stderr, "gateway-profiles: FAIL %s\n", name);
    failures++;
  }
}

static const BYTE RANDOM[KEIKO_PROFILE_RANDOM_BYTES] = {0x01, 0x23, 0x45, 0x67,
                                                       0x89, 0xab, 0xcd, 0xef};

static int never_alive(const struct keiko_environment_holder *owner) {
  (void)owner;
  return 0;
}

static int always_alive(const struct keiko_environment_holder *owner) {
  (void)owner;
  return 1;
}

static void test_names(void) {
  struct keiko_environment_holder owner = {0x1234u, {0x9abcdef0u, 0x01d9a5b2u}}, parsed;
  wchar_t name[KEIKO_PROFILE_NAME_CHARS];
  check(keiko_profile_name(KEIKO_PROFILE_PREFIX_RELAY, &owner, RANDOM, name), "relay name");
  check(wcscmp(name, L"Keiko.Relay.00001234-01d9a5b29abcdef0-0123456789abcdef") == 0,
        "relay name grammar");
  check(keiko_profile_owner(name, &parsed) && parsed.pid == owner.pid &&
            parsed.created.dwHighDateTime == owner.created.dwHighDateTime &&
            parsed.created.dwLowDateTime == owner.created.dwLowDateTime,
        "owner round trip");
  check(keiko_profile_owner(L"keiko.step.00001234-01d9a5b29abcdef0-0123456789abcdef", &parsed),
        "Windows keeps names case-insensitively");
  check(!keiko_profile_name(L"Keiko.Other.", &owner, RANDOM, name), "unknown prefix");
  check(!keiko_profile_name(L"Keiko.Relay.x", &owner, RANDOM, name), "prefix with a tail");
}

static void test_foreign_names(void) {
  static const wchar_t *const FOREIGN[] = {
      /* An older Keiko's profile: 32 random hex digits, no owner. */
      L"Keiko.Relay.0123456789abcdef0123456789abcdef",
      L"Keiko.Step.0123456789abcdef0123456789abcdef",
      L"Microsoft.Windows.Search_cw5n1h2txyewy",
      L"Keiko.Relay.00001234-01d9a5b29abcdef0-0123456789abcde",
      L"Keiko.Relay.00001234-01d9a5b29abcdef0-0123456789abcdef0",
      L"Keiko.Relay.00001234_01d9a5b29abcdef0-0123456789abcdef",
      L"Keiko.Relay.0000123g-01d9a5b29abcdef0-0123456789abcdef",
      L"Keiko.Relay.00000000-01d9a5b29abcdef0-0123456789abcdef",
      L"Keiko.Relay.00001234-0000000000000000-0123456789abcdef",
      L"Keiko.Relay.",
      L"",
  };
  struct keiko_environment_holder parsed;
  for (size_t index = 0; index < sizeof(FOREIGN) / sizeof(FOREIGN[0]); index++) {
    check(!keiko_profile_owner(FOREIGN[index], &parsed), "foreign name has no owner");
    check(!keiko_profile_stale(FOREIGN[index], never_alive), "foreign name is never stale");
  }
  check(keiko_profile_stale(L"Keiko.Step.00001234-01d9a5b29abcdef0-0123456789abcdef",
                            never_alive),
        "a gone owner's profile is stale");
  check(!keiko_profile_stale(L"Keiko.Step.00001234-01d9a5b29abcdef0-0123456789abcdef",
                             always_alive),
        "a live owner's profile is kept");
}

static void test_window_station(void) {
  check(keiko_window_station_interactive(L"WinSta0"), "interactive station");
  check(keiko_window_station_interactive(L"winsta0"), "station name case");
  check(!keiko_window_station_interactive(L"Service-0x0-3e7$"), "service station");
  check(!keiko_window_station_interactive(L""), "no station");
}

static int profile_exists(const wchar_t *name) {
  PSID sid = NULL;
  HRESULT result = DeriveAppContainerSidFromAppContainerName(name, &sid);
  HKEY key;
  wchar_t *text = NULL;
  wchar_t path[512];
  int exists = 0;
  if (FAILED(result) || !ConvertSidToStringSidW(sid, &text)) {
    if (sid != NULL) FreeSid(sid);
    return 0;
  }
  _snwprintf_s(path, 512, _TRUNCATE,
               L"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\"
               L"CurrentVersion\\AppContainer\\Mappings\\%ls",
               text);
  if (RegOpenKeyExW(HKEY_CURRENT_USER, path, 0, KEY_READ, &key) == ERROR_SUCCESS) {
    exists = 1;
    RegCloseKey(key);
  }
  LocalFree(text);
  FreeSid(sid);
  return exists;
}

static int create_profile(const wchar_t *name) {
  PSID sid = NULL;
  HRESULT result = CreateAppContainerProfile(name, name, L"Keiko profile sweep test", NULL, 0,
                                             &sid);
  if (sid != NULL) FreeSid(sid);
  return SUCCEEDED(result);
}

/* A crashed run's profile (its owner's process id is this test's, its creation time is not) goes;
 * a live run's profile and a foreign one stay. */
static void test_sweep(void) {
  struct keiko_environment_holder self, crashed;
  struct keiko_profile_sweep sweep;
  wchar_t live[KEIKO_PROFILE_NAME_CHARS], gone[KEIKO_PROFILE_NAME_CHARS];
  wchar_t foreign[KEIKO_PROFILE_NAME_CHARS];
  BYTE random[KEIKO_PROFILE_RANDOM_BYTES];
  check(keiko_environment_holder_self(&self), "self holder");
  crashed = self;
  crashed.created.dwLowDateTime ^= 0x5a5a5a5au;
  check(BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
        "random");
  check(keiko_profile_name(KEIKO_PROFILE_PREFIX_STEP, &self, random, live), "live name");
  check(keiko_profile_name(KEIKO_PROFILE_PREFIX_RELAY, &crashed, random, gone), "gone name");
  _snwprintf_s(foreign, KEIKO_PROFILE_NAME_CHARS, _TRUNCATE, L"Keiko.Relay.%02x%02x%02x%02x",
               random[0], random[1], random[2], random[3]);
  check(create_profile(live) && create_profile(gone) && create_profile(foreign), "fixtures");
  keiko_profiles_sweep(&sweep);
  check(sweep.removed >= 1, "the crashed run's profile is counted");
  check(!profile_exists(gone), "the crashed run's profile is removed");
  check(profile_exists(live), "the live run's profile stays");
  check(profile_exists(foreign), "a foreign profile stays");
  (void)DeleteAppContainerProfile(live);
  (void)DeleteAppContainerProfile(gone);
  (void)DeleteAppContainerProfile(foreign);
}

int main(void) {
  test_names();
  test_foreign_names();
  test_window_station();
  test_sweep();
  if (failures != 0) return 1;
  puts("gateway-profiles-rules: passed");
  return 0;
}

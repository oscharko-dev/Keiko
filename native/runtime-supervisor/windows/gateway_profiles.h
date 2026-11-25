#ifndef KEIKO_GATEWAY_PROFILES_H
#define KEIKO_GATEWAY_PROFILES_H
#include "gateway_environment.h"

/* #4495: the per-run AppContainer profile of a confined launch, and the session it needs.
 *
 * A profile's name states the supervisor that created it: `<prefix><pid>-<created>-<random>`, the
 * process id as 8 and its creation time as 16 lowercase hex digits, then 16 random ones. A later
 * launch removes a profile whose supervisor is gone (the supervisor's Job Object took its tree with
 * it) and never one whose supervisor lives, also another Keiko installation's. A name outside this
 * grammar, an older Keiko's random name or any other program's profile, is foreign: never touched. */
#define KEIKO_PROFILE_NAME_CHARS 64u
#define KEIKO_PROFILE_RANDOM_BYTES 8u
#define KEIKO_PROFILE_PREFIX_RELAY L"Keiko.Relay."
#define KEIKO_PROFILE_PREFIX_STEP L"Keiko.Step."
/* The most stale profiles one launch removes; any left over go at the next launch. */
#define KEIKO_PROFILE_SWEEP_MAX 64u

/* Formats the name of a profile `owner` creates; 0 for an unknown prefix. */
int keiko_profile_name(_In_z_ const wchar_t *prefix,
                       _In_ const struct keiko_environment_holder *owner,
                       _In_reads_(KEIKO_PROFILE_RANDOM_BYTES) const BYTE *random,
                       _Out_writes_z_(KEIKO_PROFILE_NAME_CHARS) wchar_t *name);
/* The supervisor a Keiko profile name states; 0 for a foreign name. */
int keiko_profile_owner(_In_z_ const wchar_t *name, _Out_ struct keiko_environment_holder *owner);
typedef int (*keiko_profile_alive)(_In_ const struct keiko_environment_holder *owner);
/* A Keiko profile whose supervisor `alive` finds gone. */
int keiko_profile_stale(_In_z_ const wchar_t *name, _In_ keiko_profile_alive alive);

struct keiko_profile_sweep {
  DWORD removed;
  DWORD failed;
};
/* Removes this user's stale Keiko profiles (keiko_profile_stale with the holder liveness check);
 * counts what it removed and what Windows refused to remove. Never fails the launch. */
void keiko_profiles_sweep(_Out_ struct keiko_profile_sweep *sweep);

/* An AppContainer process needs the interactive window station: in an SSH or service session its
 * root ends with STATUS_DLL_INIT_FAILED (0xC0000142) before it runs a line. */
int keiko_window_station_interactive(_In_z_ const wchar_t *name);
/* Whether this process runs on the interactive window station. */
int keiko_session_interactive(void);
#endif

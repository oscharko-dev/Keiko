#ifndef KEIKO_GATEWAY_ENVIRONMENT_H
#define KEIKO_GATEWAY_ENVIRONMENT_H
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

/* #4068 W1 (proposal C): an AppContainer root reads HKCU\Environment through the key's own read
 * entries for ALL APPLICATION PACKAGES and the registryRead capability, so a value stored with `setx`
 * is readable beside the launch allowlist. While a confined tree runs, the supervisor removes those
 * entries; the last run to end puts them back. A record under the user's Software key names the live
 * holders and the removed entries, so a crashed run is pruned by the next close or reopen. */

#define KEIKO_ENVIRONMENT_HOLDERS_MAX 64u
#define KEIKO_ENVIRONMENT_PRINCIPALS 3u

/* `key` is the guarded key as a security object name (`CURRENT_USER\...`); `record` is a path
 * below `root`; `lock` names the per-session mutex. */
struct keiko_environment_target {
  HKEY root;
  const wchar_t *key;
  const wchar_t *record;
  const wchar_t *lock;
};

/* A supervisor process, identified by its id and creation time so a reused id is not mistaken for
 * a live holder. */
struct keiko_environment_holder {
  DWORD pid;
  FILETIME created;
};

/* The user's own key, the supervisor's record and its per-session lock. */
extern const struct keiko_environment_target KEIKO_ENVIRONMENT_USER;

/* This process as a holder. */
int keiko_environment_holder_self(_Out_ struct keiko_environment_holder *holder);

/* Records the holder and the entries it removes, then removes the key's application-package read
 * entries and verifies none is left. Any failure unrecords the holder, restores what it removed when
 * no other holder lives, and refuses the launch. An inherited entry or one that grants more than
 * read is never edited: the close is refused. */
DWORD keiko_environment_close(_In_ const struct keiko_environment_target *target,
                              _In_ const struct keiko_environment_holder *holder);

/* The same close, which first calls `alone` under the guard's lock when no recorded holder still
 * lives. A supervisor records itself before it grants its tree anything and revokes those grants
 * before it is forgotten, so no confined tree of this user holds a tree grant at that point
 * (#4068, ADR-0043 D18). */
typedef void (*keiko_environment_alone)(_Inout_ void *context);
DWORD keiko_environment_close_alone(_In_ const struct keiko_environment_target *target,
                                    _In_ const struct keiko_environment_holder *holder,
                                    _In_opt_ keiko_environment_alone alone,
                                    _Inout_opt_ void *context);

/* Forgets the holder and every holder whose process is gone. When none is left, restores the
 * removed entries and deletes the record. A failure keeps the key closed; the next close or reopen
 * retries. */
DWORD keiko_environment_reopen(_In_ const struct keiko_environment_target *target,
                               _In_ const struct keiko_environment_holder *holder);
#endif

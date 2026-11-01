#include "gateway_loopback.h"

#include <stdlib.h>

/* FirewallAPI.dll's documented network-isolation configuration API. The list is machine-wide
 * and replaced as a whole, so every change is read-modify-write of the complete list under one
 * process-wide lock; entries this service did not add are carried over unchanged. */
typedef keiko_gateway_loopback_get_fn get_config_fn;
typedef keiko_gateway_loopback_set_fn set_config_fn;

static SRWLOCK config_lock = SRWLOCK_INIT;

struct loopback_api {
  HMODULE module;
  get_config_fn get;
  set_config_fn set;
};

static DWORD load_api(struct loopback_api *api) {
  union { FARPROC address; get_config_fn call; } get = {0};
  union { FARPROC address; set_config_fn call; } set = {0};
  api->module = LoadLibraryExW(L"FirewallAPI.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (api->module == NULL) return GetLastError();
  get.address = GetProcAddress(api->module, "NetworkIsolationGetAppContainerConfig");
  set.address = GetProcAddress(api->module, "NetworkIsolationSetAppContainerConfig");
  if (get.address == NULL || set.address == NULL) {
    FreeLibrary(api->module);
    api->module = NULL;
    return ERROR_PROC_NOT_FOUND;
  }
  api->get = get.call;
  api->set = set.call;
  return ERROR_SUCCESS;
}

/* Writes the current list with package_sid added (add != 0) or removed (add == 0): every other
 * entry is carried over once, package_sid at most once, and an unchanged list is not written
 * back. Each returned entry is visited exactly once: carried into the new list or released at
 * once; carried entries are released from the new list after the write, as the API requires.
 *
 * C6001 is disabled for this function only. The entries and the SIDs they point to are allocated
 * and written by NetworkIsolationGetAppContainerConfig, which is resolved at run time, so the
 * analyzer cannot see the write and reports every read or HeapFree of them as uninitialized. */
#pragma warning(push)
#pragma warning(disable : 6001)
static DWORD update(get_config_fn get, set_config_fn set, PSID package_sid, int add) {
  PSID_AND_ATTRIBUTES current = NULL, next = NULL;
  DWORD count = 0, kept = 0, index, result;
  result = get(&count, &current);
  if (result != ERROR_SUCCESS) return result;
  next = calloc((size_t)count + 1, sizeof(*next));
  if (next == NULL) result = ERROR_OUTOFMEMORY;
  for (index = 0; index < count; index++) {
    PSID entry = current[index].Sid;
    if (next == NULL || (entry != NULL && EqualSid(entry, package_sid))) {
      HeapFree(GetProcessHeap(), 0, entry);
      continue;
    }
    next[kept++] = current[index];
  }
  if (next != NULL) {
    DWORD wanted = kept + (add ? 1u : 0u);
    if (add) next[kept].Sid = package_sid;
    if (wanted != count) result = set(wanted, next);
    for (index = 0; index < kept; index++) HeapFree(GetProcessHeap(), 0, next[index].Sid);
    free(next);
  }
  if (current != NULL) HeapFree(GetProcessHeap(), 0, current);
  return result;
}
#pragma warning(pop)

DWORD keiko_gateway_loopback_apply(keiko_gateway_loopback_get_fn get,
                                   keiko_gateway_loopback_set_fn set, PSID package_sid, int add) {
  DWORD result;
  if (get == NULL || set == NULL || package_sid == NULL || !IsValidSid(package_sid))
    return ERROR_INVALID_PARAMETER;
  AcquireSRWLockExclusive(&config_lock);
  result = update(get, set, package_sid, add);
  ReleaseSRWLockExclusive(&config_lock);
  return result;
}

static DWORD change(PSID package_sid, int add) {
  struct loopback_api api = {0};
  DWORD result;
  if (package_sid == NULL || !IsValidSid(package_sid)) return ERROR_INVALID_PARAMETER;
  result = load_api(&api);
  if (result != ERROR_SUCCESS) return result;
  result = keiko_gateway_loopback_apply(api.get, api.set, package_sid, add);
  if (api.module != NULL) FreeLibrary(api.module);
  return result;
}

DWORD keiko_gateway_loopback_exempt(PSID package_sid) { return change(package_sid, 1); }

DWORD keiko_gateway_loopback_revoke(PSID package_sid) { return change(package_sid, 0); }

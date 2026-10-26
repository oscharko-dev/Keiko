/* Disposable-runner diagnostics only. Never linked into the installed service.
 * Restrict collection reads to this synthetic executable and time interval; never emit raw
 * event data, filter names, identities, addresses, ports, paths or provider-supplied strings. */
#include "gateway_wfp.h"
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>

struct gateway_diagnostics {
  HANDLE engine;
  FWP_VALUE0 *previous;
  FWP_BYTE_BLOB *app;
  FILETIME started;
};

DWORD gateway_diagnostics_stop(struct gateway_diagnostics *owner) {
  DWORD result = ERROR_SUCCESS, closed;
  if (owner == NULL) return result;
  if (owner->previous != NULL) {
    result = FwpmEngineSetOption0(owner->engine, FWPM_ENGINE_COLLECT_NET_EVENTS, owner->previous);
    FwpmFreeMemory0((void **)&owner->previous);
  }
  if (owner->app != NULL) FwpmFreeMemory0((void **)&owner->app);
  if (owner->engine != NULL) {
    closed = FwpmEngineClose0(owner->engine);
    if (closed != ERROR_SUCCESS) result = closed;
  }
  free(owner);
  return result;
}

DWORD gateway_diagnostics_start(const wchar_t *executable, struct gateway_diagnostics **owned) {
  struct gateway_diagnostics *owner;
  FWP_VALUE0 enabled = {0};
  DWORD result;
  if (owned == NULL || *owned != NULL) return ERROR_INVALID_PARAMETER;
  owner = calloc(1, sizeof(*owner));
  if (owner == NULL) return ERROR_OUTOFMEMORY;
  result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &owner->engine);
  if (result == ERROR_SUCCESS)
    result = FwpmEngineGetOption0(owner->engine, FWPM_ENGINE_COLLECT_NET_EVENTS, &owner->previous);
  if (result == ERROR_SUCCESS) {
    enabled.type = FWP_UINT32;
    enabled.uint32 = 1;
    result = FwpmEngineSetOption0(owner->engine, FWPM_ENGINE_COLLECT_NET_EVENTS, &enabled);
  }
  if (result == ERROR_SUCCESS) result = FwpmGetAppIdFromFileName0(executable, &owner->app);
  if (result == ERROR_SUCCESS) {
    GetSystemTimeAsFileTime(&owner->started);
    *owned = owner;
  } else (void)gateway_diagnostics_stop(owner);
  return result;
}

static const char *drop_sublayer(const GUID *key) {
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_APP_ISOLATION)) return "app-isolation";
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_WF)) return "windows-firewall";
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_WSH)) return "service-hardening";
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_QUARANTINE)) return "quarantine";
  return "other";
}

static void describe_drop(HANDLE engine, const FWPM_NET_EVENT2 *event, PSID sid) {
  FWPM_FILTER0 *filter = NULL;
  DWORD result;
  int package = (event->header.flags & FWPM_NET_EVENT_FLAG_PACKAGE_ID_SET) != 0 &&
    event->header.packageSid != NULL && EqualSid(event->header.packageSid, sid);
  if (event->type == FWPM_NET_EVENT_TYPE_CAPABILITY_DROP && event->capabilityDrop != NULL) {
    printf("socket-wfp-drop: type=capability capability=%u package=%d\n",
           (unsigned)event->capabilityDrop->networkCapabilityId, package);
    return;
  }
  if (event->type != FWPM_NET_EVENT_TYPE_CLASSIFY_DROP || event->classifyDrop == NULL) return;
  result = FwpmFilterGetById0(engine, event->classifyDrop->filterId, &filter);
  printf("socket-wfp-drop: type=classify layer=%u direction=%lu loopback=%d package=%d readback=%lu",
         (unsigned)event->classifyDrop->layerId, (unsigned long)event->classifyDrop->msFwpDirection,
         event->classifyDrop->isLoopback != FALSE, package, result);
  if (result == ERROR_SUCCESS) {
    printf(" sublayer=%s action=%lu flags=%lu conditions=%lu",
           drop_sublayer(&filter->subLayerKey), (unsigned long)filter->action.type,
           (unsigned long)filter->flags, (unsigned long)filter->numFilterConditions);
    FwpmFreeMemory0((void **)&filter);
  }
  printf("\n");
}

DWORD gateway_diagnostics_read(struct gateway_diagnostics *owner, PSID sid) {
  FWPM_NET_EVENT_ENUM_TEMPLATE0 query = {0};
  FWPM_FILTER_CONDITION0 condition = {0};
  HANDLE enumeration = NULL;
  DWORD result, closed;
  UINT32 count = 0, total = 0;
  if (owner == NULL) return ERROR_INVALID_PARAMETER;
  query.startTime = owner->started;
  GetSystemTimeAsFileTime(&query.endTime);
  condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
  condition.matchType = FWP_MATCH_EQUAL;
  condition.conditionValue.type = FWP_BYTE_BLOB_TYPE;
  condition.conditionValue.byteBlob = owner->app;
  query.numFilterConditions = 1;
  query.filterCondition = &condition;
  result = FwpmNetEventCreateEnumHandle0(owner->engine, &query, &enumeration);
  if (result != ERROR_SUCCESS) return result;
  /* Hard ceiling even if an unexpected source floods this fixture's executable identity. */
  for (unsigned page = 0; page < 8 && result == ERROR_SUCCESS; page++) {
    FWPM_NET_EVENT2 **events = NULL;
    result = FwpmNetEventEnum2(owner->engine, enumeration, 32, &events, &count);
    if (result == ERROR_SUCCESS) {
      for (UINT32 index = 0; index < count; index++) describe_drop(owner->engine, events[index], sid);
      total += count;
    }
    if (events != NULL) FwpmFreeMemory0((void **)&events);
    if (count < 32) break;
  }
  closed = FwpmNetEventDestroyEnumHandle0(owner->engine, enumeration);
  if (closed != ERROR_SUCCESS) result = closed;
  printf("socket-wfp-diagnostics: code=%lu events=%lu bounded=%d\n",
         result, (unsigned long)total, total == 256);
  return result;
}

/* Read-only BFE diagnostic for a disposable reference runner. Report only drops for the
 * synthetic probe or its host listener, on the two tested ports in a short time window. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>
#include <stdio.h>

static const char *sublayer(const GUID *key) {
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_APP_ISOLATION)) return "app-isolation";
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_WF)) return "windows-firewall";
  if (IsEqualGUID(key, &FWPM_SUBLAYER_MPSSVC_WSH)) return "service-hardening";
  return "other";
}

static const char *layer(const GUID *key) {
  if (IsEqualGUID(key, &FWPM_LAYER_ALE_AUTH_CONNECT_V4)) return "connect-v4";
  if (IsEqualGUID(key, &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4)) return "accept-v4";
  return "other";
}

static void describe(HANDLE engine, const FWPM_NET_EVENT2 *event, const char *image,
                     UINT16 allowed, UINT16 hostile) {
  const FWPM_NET_EVENT_HEADER2 *header = &event->header;
  UINT16 remote = header->flags & FWPM_NET_EVENT_FLAG_REMOTE_PORT_SET ? header->remotePort : 0;
  UINT16 local = header->flags & FWPM_NET_EVENT_FLAG_LOCAL_PORT_SET ? header->localPort : 0;
  const char *target;
  if (remote == allowed || local == allowed) target = "gateway";
  else if (remote == hostile || local == hostile) target = "other-port";
  else return;
  if (event->type == FWPM_NET_EVENT_TYPE_CAPABILITY_DROP && event->capabilityDrop) {
    printf("WFP drop image=%s endpoint=%s capability=%u\n", image, target,
           (unsigned)event->capabilityDrop->networkCapabilityId);
  } else if (event->type == FWPM_NET_EVENT_TYPE_CLASSIFY_DROP && event->classifyDrop) {
    FWPM_FILTER0 *filter = NULL;
    DWORD result = FwpmFilterGetById0(engine, event->classifyDrop->filterId, &filter);
    printf("WFP drop image=%s endpoint=%s readback=%lu", image, target, result);
    if (result == ERROR_SUCCESS && filter) {
      printf(" layer=%s sublayer=%s", layer(&filter->layerKey), sublayer(&filter->subLayerKey));
      FwpmFreeMemory0((void **)&filter);
    }
    puts("");
  }
}

static DWORD trace_image(HANDLE engine, const wchar_t *path, const char *label,
                         UINT16 allowed, UINT16 hostile) {
  FWPM_NET_EVENT_ENUM_TEMPLATE0 query = {0};
  FWPM_FILTER_CONDITION0 condition = {0};
  FWP_BYTE_BLOB *app = NULL;
  HANDLE enumeration = NULL;
  ULARGE_INTEGER start;
  DWORD result = FwpmGetAppIdFromFileName0(path, &app);
  if (result != ERROR_SUCCESS) return result;
  GetSystemTimeAsFileTime(&query.endTime);
  start.LowPart = query.endTime.dwLowDateTime;
  start.HighPart = query.endTime.dwHighDateTime;
  start.QuadPart -= 30ULL * 10000000;
  query.startTime.dwLowDateTime = start.LowPart;
  query.startTime.dwHighDateTime = start.HighPart;
  condition.fieldKey = FWPM_CONDITION_ALE_APP_ID;
  condition.matchType = FWP_MATCH_EQUAL;
  condition.conditionValue.type = FWP_BYTE_BLOB_TYPE;
  condition.conditionValue.byteBlob = app;
  query.numFilterConditions = 1;
  query.filterCondition = &condition;
  result = FwpmNetEventCreateEnumHandle0(engine, &query, &enumeration);
  for (int page = 0; page < 8 && result == ERROR_SUCCESS; page++) {
    FWPM_NET_EVENT2 **events = NULL;
    UINT32 count = 0;
    result = FwpmNetEventEnum2(engine, enumeration, 32, &events, &count);
    if (result == ERROR_SUCCESS)
      for (UINT32 i = 0; i < count; i++) describe(engine, events[i], label, allowed, hostile);
    if (events) FwpmFreeMemory0((void **)&events);
    if (count < 32) break;
  }
  if (enumeration) FwpmNetEventDestroyEnumHandle0(engine, enumeration);
  FwpmFreeMemory0((void **)&app);
  return result;
}

int gateway_trace_ports(const wchar_t *probe, const wchar_t *host, UINT16 allowed, UINT16 hostile) {
  HANDLE engine = NULL;
  DWORD result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &engine);
  if (result == ERROR_SUCCESS) result = trace_image(engine, probe, "probe", allowed, hostile);
  if (result == ERROR_SUCCESS) result = trace_image(engine, host, "listener", allowed, hostile);
  if (engine) FwpmEngineClose0(engine);
  printf("WFP diagnostic query status=%lu\n", result);
  return result == ERROR_SUCCESS ? 0 : 1;
}

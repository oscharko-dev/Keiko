/* Disposable-runner experiment only. Never linked into a shipping service or local default test.
 * Each owner has its own dynamic session. No shared CheckNetIsolation provider is registered.
 * The separate firewall fixture still binds package, executable, user and ephemeral TCP port. */
#include "gateway_wfp.h"
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct gateway_inbound_fixture { HANDLE engine; GUID key; };
/* WFP takes a non-const pointer but only reads this fixed value. Never modify it. */
static UINT64 inbound_weight = ~(UINT64)0;
static FWP_BYTE_ARRAY16 inbound_loopback6 = {{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}};

static int inbound_package(PSID sid) {
  const SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  return sid != NULL && IsValidSid(sid) &&
    memcmp(GetSidIdentifierAuthority(sid), &authority, sizeof(authority)) == 0 &&
    *GetSidSubAuthorityCount(sid) == SECURITY_APP_PACKAGE_RID_COUNT &&
    *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

static void inbound_spec(PSID sid, UINT16 family, const GUID *key, FWPM_FILTER0 *filter,
                         FWPM_FILTER_CONDITION0 conditions[4]) {
  memset(filter, 0, sizeof(*filter));
  memset(conditions, 0, 4 * sizeof(*conditions));
  filter->filterKey = *key;
  filter->displayData.name = L"Keiko owned inbound loopback experiment";
  filter->layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 :
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
  filter->subLayerKey = FWPM_SUBLAYER_MPSSVC_APP_ISOLATION;
  /* A soft permit: independent sublayer BLOCK decisions must still win. This fixture does
   * not establish compatibility with arbitrary policies in the same system sublayer. */
  filter->action.type = FWP_ACTION_PERMIT;
  filter->weight.type = FWP_UINT64;
  filter->weight.uint64 = &inbound_weight;
  filter->numFilterConditions = 4;
  filter->filterCondition = conditions;
  conditions[0].fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
  conditions[0].matchType = FWP_MATCH_EQUAL;
  conditions[0].conditionValue.type = FWP_SID;
  conditions[0].conditionValue.sid = sid;
  conditions[1].fieldKey = FWPM_CONDITION_FLAGS;
  conditions[1].matchType = FWP_MATCH_FLAGS_ALL_SET;
  conditions[1].conditionValue.type = FWP_UINT32;
  conditions[1].conditionValue.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
  conditions[2].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
  conditions[2].matchType = FWP_MATCH_EQUAL;
  conditions[2].conditionValue.type = FWP_UINT8;
  conditions[2].conditionValue.uint8 = IPPROTO_TCP;
  conditions[3].fieldKey = FWPM_CONDITION_IP_LOCAL_ADDRESS;
  conditions[3].matchType = FWP_MATCH_EQUAL;
  if (family == AF_INET) {
    conditions[3].conditionValue.type = FWP_UINT32;
    conditions[3].conditionValue.uint32 = INADDR_LOOPBACK;
  } else {
    conditions[3].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
    conditions[3].conditionValue.byteArray16 = &inbound_loopback6;
  }
}

static int inbound_matches(const FWPM_FILTER0 *filter, PSID sid, UINT16 family, const GUID *key) {
  unsigned seen = 0;
  if ((family != AF_INET && family != AF_INET6) || filter == NULL || !IsEqualGUID(&filter->filterKey, key) ||
      !IsEqualGUID(&filter->layerKey, family == AF_INET ?
        &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 : &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6) ||
      !IsEqualGUID(&filter->subLayerKey, &FWPM_SUBLAYER_MPSSVC_APP_ISOLATION) ||
      filter->action.type != FWP_ACTION_PERMIT ||
      (filter->flags & ~FWPM_FILTER_FLAG_INDEXED) != 0 || filter->providerKey != NULL ||
      filter->weight.type != FWP_UINT64 || filter->weight.uint64 == NULL ||
      *filter->weight.uint64 != ~(UINT64)0 ||
      filter->numFilterConditions != 4 || filter->filterCondition == NULL) return 0;
  for (UINT32 i = 0; i < 4; i++) {
    const FWPM_FILTER_CONDITION0 *c = &filter->filterCondition[i];
    unsigned bit = 0;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID) &&
        c->matchType == FWP_MATCH_EQUAL && c->conditionValue.type == FWP_SID &&
        inbound_package(c->conditionValue.sid) && EqualSid(c->conditionValue.sid, sid)) bit = 1;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_FLAGS) &&
        c->matchType == FWP_MATCH_FLAGS_ALL_SET && c->conditionValue.type == FWP_UINT32 &&
        c->conditionValue.uint32 == FWP_CONDITION_FLAG_IS_LOOPBACK) bit = 2;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_PROTOCOL) &&
        c->matchType == FWP_MATCH_EQUAL && c->conditionValue.type == FWP_UINT8 &&
        c->conditionValue.uint8 == IPPROTO_TCP) bit = 4;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_LOCAL_ADDRESS) &&
        c->matchType == FWP_MATCH_EQUAL) {
      if (family == AF_INET && c->conditionValue.type == FWP_UINT32 &&
          c->conditionValue.uint32 == INADDR_LOOPBACK) bit = 8;
      if (family == AF_INET6 && c->conditionValue.type == FWP_BYTE_ARRAY16_TYPE &&
          c->conditionValue.byteArray16 != NULL &&
          memcmp(c->conditionValue.byteArray16, &inbound_loopback6, sizeof(inbound_loopback6)) == 0) bit = 8;
    }
    if (bit == 0 || (seen & bit) != 0) return 0;
    seen |= bit;
  }
  return seen == 15;
}

DWORD gateway_inbound_stop(struct gateway_inbound_fixture *fixture) {
  HANDLE observer = NULL;
  FWPM_FILTER0 *remaining = NULL;
  DWORD result, observed;
  if (fixture == NULL) return ERROR_SUCCESS;
  result = FwpmEngineClose0(fixture->engine);
  if (result == ERROR_SUCCESS) {
    result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &observer);
    if (result == ERROR_SUCCESS) {
      observed = FwpmFilterGetByKey0(observer, &fixture->key, &remaining);
      result = observed == FWP_E_FILTER_NOT_FOUND ? ERROR_SUCCESS :
        observed == ERROR_SUCCESS ? ERROR_INVALID_DATA : observed;
      if (remaining != NULL) FwpmFreeMemory0((void **)&remaining);
      observed = FwpmEngineClose0(observer);
      if (observed != ERROR_SUCCESS) result = observed;
    }
  }
  free(fixture);
  printf("socket-inbound-owned-cleanup: code=%lu\n", result);
  return result;
}

DWORD gateway_inbound_start(PSID sid, UINT16 family, struct gateway_inbound_fixture **owned) {
  struct gateway_inbound_fixture *fixture;
  FWPM_SESSION0 session = {0};
  FWPM_FILTER0 filter, *installed = NULL;
  FWPM_FILTER_CONDITION0 conditions[4];
  DWORD result, closed;
  if (owned == NULL || *owned != NULL || !inbound_package(sid) ||
      (family != AF_INET && family != AF_INET6)) return ERROR_INVALID_PARAMETER;
  fixture = calloc(1, sizeof(*fixture));
  if (fixture == NULL) return ERROR_OUTOFMEMORY;
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.txnWaitTimeoutInMSec = 5000;
  result = UuidCreate(&fixture->key);
  if (result == RPC_S_UUID_LOCAL_ONLY) result = ERROR_SUCCESS;
  if (result == ERROR_SUCCESS)
    result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, &fixture->engine);
  inbound_spec(sid, family, &fixture->key, &filter, conditions);
  if (result == ERROR_SUCCESS) result = FwpmFilterAdd0(fixture->engine, &filter, NULL, NULL);
  if (result == ERROR_SUCCESS) result = FwpmFilterGetByKey0(fixture->engine, &fixture->key, &installed);
  if (result == ERROR_SUCCESS && !inbound_matches(installed, sid, family, &fixture->key)) result = ERROR_INVALID_DATA;
  if (installed != NULL) FwpmFreeMemory0((void **)&installed);
  if (result == ERROR_SUCCESS) *owned = fixture;
  else if (fixture->engine != NULL) {
    closed = gateway_inbound_stop(fixture);
    if (closed != ERROR_SUCCESS) result = closed;
  } else free(fixture);
  printf("socket-inbound-owned-provision: family=%u code=%lu\n", (unsigned)family, result);
  return result;
}

/* Pure readback rejection tests: never open WFP or change host policy. */
int gateway_inbound_spec_tests(void) {
  PSID sid = NULL, peer = NULL;
  GUID key = {1, 0, 0, {0}};
  FWPM_FILTER0 filter;
  FWPM_FILTER_CONDITION0 conditions[4];
  UINT64 lower_weight = 1;
  FWP_BYTE_ARRAY16 wrong_address = {{1}};
  int ok = 1;
  if (!ConvertStringSidToSidW(L"S-1-15-2-1-2-3-4-5-6-7", &sid)) return 1;
  if (!ConvertStringSidToSidW(L"S-1-15-2-8-2-3-4-5-6-7", &peer)) { LocalFree(sid); return 1; }
  for (int family = AF_INET; family <= AF_INET6; family += AF_INET6 - AF_INET) {
    for (unsigned mutation = 0; mutation < 18; mutation++) {
      inbound_spec(sid, (UINT16)family, &key, &filter, conditions);
      if (filter.weight.type != FWP_UINT64 || filter.weight.uint64 == NULL ||
          *filter.weight.uint64 != ~(UINT64)0) ok = 0;
      if (!IsEqualGUID(&filter.layerKey, family == AF_INET ?
          &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 : &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6)) ok = 0;
      switch (mutation) {
        case 1: filter.flags = FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT; break;
        case 2: conditions[0].conditionValue.sid = peer; break;
        case 3: conditions[1].matchType = FWP_MATCH_FLAGS_ANY_SET; break;
        case 4: conditions[2].conditionValue.uint8 = IPPROTO_UDP; break;
        case 5:
          if (family == AF_INET) conditions[3].conditionValue.uint32 = INADDR_ANY;
          else conditions[3].conditionValue.byteArray16 = &wrong_address;
          break;
        case 6: filter.numFilterConditions = 3; break;
        case 7: conditions[3] = conditions[2]; break;
        case 8: filter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V4; break;
        case 9: filter.providerKey = &key; break;
        case 10: filter.filterKey.Data1++; break;
        case 11: filter.flags = FWPM_FILTER_FLAG_INDEXED; break;
        case 12: filter.weight.type = FWP_UINT8; filter.weight.uint8 = 15; break;
        case 13: filter.weight.uint64 = NULL; break;
        case 14: filter.weight.uint64 = &lower_weight; break;
        case 15: filter.layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6 :
            FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4; break;
        case 16: conditions[3].conditionValue.type = FWP_EMPTY; break;
        case 17: conditions[3].conditionValue.byteArray16 = NULL; break;
        default: break;
      }
      if (inbound_matches(&filter, sid, (UINT16)family, &key) != (mutation == 0 || mutation == 11)) ok = 0;
    }
  }
  {
    struct gateway_inbound_fixture *owner = NULL;
    if (gateway_inbound_start(sid, AF_UNSPEC, &owner) != ERROR_INVALID_PARAMETER || owner != NULL) ok = 0;
  }
  LocalFree(peer); LocalFree(sid);
  puts(ok ? "gateway-inbound-owned-readback: passed" : "gateway-inbound-owned-readback: failed");
  return ok ? 0 : 1;
}

DWORD gateway_inbound_block(PSID sid, UINT16 family, HANDLE *owned) {
  FWPM_SESSION0 session = {0};
  FWPM_SUBLAYER0 sublayer = {0};
  FWPM_FILTER0 filter = {0};
  FWPM_FILTER_CONDITION0 condition = {0};
  UINT64 weight = 1;
  DWORD result;
  if (owned == NULL || *owned != NULL) return ERROR_INVALID_PARAMETER;
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.txnWaitTimeoutInMSec = 5000;
  result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, owned);
  if (result != ERROR_SUCCESS) return result;
  sublayer.displayData.name = L"Keiko inbound deny coexistence fixture";
  sublayer.weight = 0x100;
  result = UuidCreate(&sublayer.subLayerKey);
  if (result == RPC_S_UUID_LOCAL_ONLY) result = ERROR_SUCCESS;
  if (result == ERROR_SUCCESS) result = FwpmSubLayerAdd0(*owned, &sublayer, NULL);
  filter.displayData.name = sublayer.displayData.name;
  filter.subLayerKey = sublayer.subLayerKey;
  filter.layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 : FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
  filter.action.type = FWP_ACTION_BLOCK;
  filter.weight.type = FWP_UINT64;
  filter.weight.uint64 = &weight;
  condition.fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
  condition.matchType = FWP_MATCH_EQUAL;
  condition.conditionValue.type = FWP_SID;
  condition.conditionValue.sid = sid;
  filter.numFilterConditions = 1;
  filter.filterCondition = &condition;
  if (result == ERROR_SUCCESS) result = FwpmFilterAdd0(*owned, &filter, NULL, NULL);
  if (result != ERROR_SUCCESS) { (void)FwpmEngineClose0(*owned); *owned = NULL; }
  return result;
}

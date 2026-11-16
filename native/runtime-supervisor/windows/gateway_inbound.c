#include "gateway_inbound.h"
#include <rpc.h>
#include <string.h>

/* WFP takes a non-const pointer but only reads these fixed values. Never modify them. The weight is
 * the explicit maximum: an automatically assigned weight in the highest range does not guarantee
 * precedence over the isolation block in the same sublayer (disposable-runner experiment, 2026-10). */
static UINT64 inbound_weight = ~(UINT64)0;
static FWP_BYTE_ARRAY16 inbound_loopback6 = {{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}};

static int inbound_package(PSID sid) {
  const SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  return sid != NULL && IsValidSid(sid) &&
         memcmp(GetSidIdentifierAuthority(sid), &authority, sizeof(authority)) == 0 &&
         *GetSidSubAuthorityCount(sid) == SECURITY_APP_PACKAGE_RID_COUNT &&
         *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

void keiko_gateway_inbound_spec(PSID sid, UINT16 family, const GUID *key, FWPM_FILTER0 *filter,
                                FWPM_FILTER_CONDITION0 conditions[4]) {
  memset(filter, 0, sizeof(*filter));
  memset(conditions, 0, 4 * sizeof(*conditions));
  filter->filterKey = *key;
  filter->displayData.name = L"Keiko runtime tree inbound control";
  filter->layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4
                                       : FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
  filter->subLayerKey = FWPM_SUBLAYER_MPSSVC_APP_ISOLATION;
  /* A soft permit: an independent BLOCK decision in any other sublayer still wins. */
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

static int inbound_header_matches(const FWPM_FILTER0 *filter, UINT16 family, const GUID *key) {
  return (family == AF_INET || family == AF_INET6) && filter != NULL &&
         IsEqualGUID(&filter->filterKey, key) &&
         IsEqualGUID(&filter->layerKey, family == AF_INET ? &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4
                                                          : &FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6) &&
         IsEqualGUID(&filter->subLayerKey, &FWPM_SUBLAYER_MPSSVC_APP_ISOLATION) &&
         filter->action.type == FWP_ACTION_PERMIT &&
         (filter->flags & ~FWPM_FILTER_FLAG_INDEXED) == 0 && filter->providerKey == NULL &&
         filter->weight.type == FWP_UINT64 && filter->weight.uint64 != NULL &&
         *filter->weight.uint64 == ~(UINT64)0 && filter->numFilterConditions == 4 &&
         filter->filterCondition != NULL;
}

static int inbound_address_matches(const FWPM_FILTER_CONDITION0 *c, UINT16 family) {
  if (family == AF_INET)
    return c->conditionValue.type == FWP_UINT32 && c->conditionValue.uint32 == INADDR_LOOPBACK;
  return c->conditionValue.type == FWP_BYTE_ARRAY16_TYPE && c->conditionValue.byteArray16 != NULL &&
         memcmp(c->conditionValue.byteArray16, &inbound_loopback6, sizeof(inbound_loopback6)) == 0;
}

static unsigned inbound_condition_bit(const FWPM_FILTER_CONDITION0 *c, PSID sid, UINT16 family) {
  if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID))
    return c->matchType == FWP_MATCH_EQUAL && c->conditionValue.type == FWP_SID &&
                   inbound_package(c->conditionValue.sid) && EqualSid(c->conditionValue.sid, sid)
               ? 1u
               : 0u;
  if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_FLAGS))
    return c->matchType == FWP_MATCH_FLAGS_ALL_SET && c->conditionValue.type == FWP_UINT32 &&
                   c->conditionValue.uint32 == FWP_CONDITION_FLAG_IS_LOOPBACK
               ? 2u
               : 0u;
  if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_PROTOCOL))
    return c->matchType == FWP_MATCH_EQUAL && c->conditionValue.type == FWP_UINT8 &&
                   c->conditionValue.uint8 == IPPROTO_TCP
               ? 4u
               : 0u;
  if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_LOCAL_ADDRESS))
    return c->matchType == FWP_MATCH_EQUAL && inbound_address_matches(c, family) ? 8u : 0u;
  return 0u;
}

int keiko_gateway_inbound_matches(const FWPM_FILTER0 *filter, PSID sid, UINT16 family,
                                  const GUID *key) {
  unsigned seen = 0;
  if (!inbound_header_matches(filter, family, key)) return 0;
  for (UINT32 i = 0; i < 4; i++) {
    unsigned bit = inbound_condition_bit(&filter->filterCondition[i], sid, family);
    if (bit == 0 || (seen & bit) != 0) return 0;
    seen |= bit;
  }
  return seen == 15;
}

DWORD keiko_gateway_inbound_admit(HANDLE engine, PSID sid, UINT16 family, GUID *key) {
  FWPM_FILTER0 filter, *installed = NULL;
  FWPM_FILTER_CONDITION0 conditions[4];
  DWORD result;
  if (engine == NULL || key == NULL || !inbound_package(sid) ||
      (family != AF_INET && family != AF_INET6))
    return ERROR_INVALID_PARAMETER;
  result = UuidCreate(key);
  if (result == RPC_S_UUID_LOCAL_ONLY) result = ERROR_SUCCESS;
  if (result != ERROR_SUCCESS) return result;
  keiko_gateway_inbound_spec(sid, family, key, &filter, conditions);
  result = FwpmFilterAdd0(engine, &filter, NULL, NULL);
  if (result == ERROR_SUCCESS) result = FwpmFilterGetByKey0(engine, key, &installed);
  if (result == ERROR_SUCCESS && !keiko_gateway_inbound_matches(installed, sid, family, key))
    result = ERROR_INVALID_DATA;
  if (installed != NULL) FwpmFreeMemory0((void **)&installed);
  return result;
}

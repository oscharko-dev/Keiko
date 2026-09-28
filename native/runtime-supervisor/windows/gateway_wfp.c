#include "gateway_wfp.h"
#include <rpc.h>
#include <string.h>
#ifdef KEIKO_GATEWAY_TEST_DIAGNOSTICS
#include <stdio.h>
#endif

static int readback_mismatch(const char *reason) {
#ifdef KEIKO_GATEWAY_TEST_DIAGNOSTICS
  printf("filter-readback: mismatch=%s\n", reason);
#else
  (void)reason;
#endif
  return 0;
}

static int package_sid_valid(PSID sid) {
  const SID_IDENTIFIER_AUTHORITY application_authority = SECURITY_APP_PACKAGE_AUTHORITY;
  if (sid == NULL || !IsValidSid(sid)) return 0;
  /* An AppContainer package SID, never a capability SID or ALL APPLICATION PACKAGES. */
  return memcmp(GetSidIdentifierAuthority(sid), &application_authority,
                sizeof(application_authority)) == 0 &&
         *GetSidSubAuthorityCount(sid) == SECURITY_APP_PACKAGE_RID_COUNT &&
         *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

static void package_condition(FWPM_FILTER_CONDITION0 *condition, PSID sid) {
  memset(condition, 0, sizeof(*condition));
  condition->fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
  condition->matchType = FWP_MATCH_EQUAL;
  condition->conditionValue.type = FWP_SID;
  condition->conditionValue.sid = sid;
}

static DWORD add_package_block(struct keiko_gateway_filters *filters, PSID sid,
                               const GUID *layer, UINT64 *id) {
  FWPM_FILTER0 filter = {0};
  FWPM_FILTER_CONDITION0 condition;
  UINT64 weight = 1;
  package_condition(&condition, sid);
  filter.displayData.name = L"Keiko runtime tree deny outbound";
  filter.layerKey = *layer;
  filter.subLayerKey = filters->sublayer;
  filter.action.type = FWP_ACTION_BLOCK;
  filter.weight.type = FWP_UINT64;
  filter.weight.uint64 = &weight;
  filter.numFilterConditions = 1;
  filter.filterCondition = &condition;
  return FwpmFilterAdd0(filters->engine, &filter, NULL, id);
}

static DWORD add_gateway_allow(struct keiko_gateway_filters *filters, PSID sid,
                               UINT16 family, UINT16 port) {
  FWPM_FILTER0 filter = {0};
  FWPM_FILTER_CONDITION0 conditions[4] = {0};
  FWP_BYTE_ARRAY16 ipv6_loopback = {{0}};
  UINT64 weight = 2;
  ipv6_loopback.byteArray16[15] = 1;
  package_condition(&conditions[0], sid);
  conditions[1].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
  conditions[1].matchType = FWP_MATCH_EQUAL;
  if (family == AF_INET) {
    conditions[1].conditionValue.type = FWP_UINT32;
    conditions[1].conditionValue.uint32 = 0x7f000001u;
  } else {
    conditions[1].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
    conditions[1].conditionValue.byteArray16 = &ipv6_loopback;
  }
  conditions[2].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
  conditions[2].matchType = FWP_MATCH_EQUAL;
  conditions[2].conditionValue.type = FWP_UINT16;
  conditions[2].conditionValue.uint16 = port;
  conditions[3].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
  conditions[3].matchType = FWP_MATCH_EQUAL;
  conditions[3].conditionValue.type = FWP_UINT8;
  conditions[3].conditionValue.uint8 = IPPROTO_TCP;
  filter.displayData.name = L"Keiko runtime tree exact gateway";
  filter.layerKey = family == AF_INET ? FWPM_LAYER_ALE_AUTH_CONNECT_V4
                                     : FWPM_LAYER_ALE_AUTH_CONNECT_V6;
  filter.subLayerKey = filters->sublayer;
  /* Soft permit: this must never bypass another provider's security policy. Within our private
   * sublayer its weight precedes the catch-all deny for this SID. */
  filter.action.type = FWP_ACTION_PERMIT;
  filter.weight.type = FWP_UINT64;
  filter.weight.uint64 = &weight;
  filter.numFilterConditions = 4;
  filter.filterCondition = conditions;
  return FwpmFilterAdd0(filters->engine, &filter, NULL, &filters->ids[2]);
}

static int same_guid(const GUID *left, const GUID *right) {
  return memcmp(left, right, sizeof(GUID)) == 0;
}

static int verify_conditions(const FWPM_FILTER0 *filter, PSID sid, UINT16 family, UINT16 port,
                              int allow) {
  UINT32 index, seen = 0;
  const BYTE loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
  if (filter->numFilterConditions != (UINT32)(allow ? 4 : 1) || filter->filterCondition == NULL)
    return readback_mismatch("condition-count");
  for (index = 0; index < filter->numFilterConditions; index++) {
    const FWPM_FILTER_CONDITION0 *condition = &filter->filterCondition[index];
    UINT32 bit = 0;
    if (condition->matchType != FWP_MATCH_EQUAL) return readback_mismatch("match-type");
    if (same_guid(&condition->fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID)) {
      if (condition->conditionValue.type != FWP_SID ||
          !package_sid_valid(condition->conditionValue.sid) ||
          !EqualSid(condition->conditionValue.sid, sid)) return readback_mismatch("package");
      bit = 1;
    } else if (allow && same_guid(&condition->fieldKey, &FWPM_CONDITION_IP_REMOTE_ADDRESS)) {
      if (family == AF_INET) {
        if (condition->conditionValue.type != FWP_UINT32 ||
            condition->conditionValue.uint32 != 0x7f000001u) return readback_mismatch("ipv4-address");
      } else if (condition->conditionValue.type != FWP_BYTE_ARRAY16_TYPE ||
                 condition->conditionValue.byteArray16 == NULL ||
                 memcmp(condition->conditionValue.byteArray16->byteArray16, loopback, 16) != 0)
        return readback_mismatch("ipv6-address");
      bit = 2;
    } else if (allow && same_guid(&condition->fieldKey, &FWPM_CONDITION_IP_REMOTE_PORT)) {
      if (condition->conditionValue.type != FWP_UINT16 || condition->conditionValue.uint16 != port)
        return readback_mismatch("port");
      bit = 4;
    } else if (allow && same_guid(&condition->fieldKey, &FWPM_CONDITION_IP_PROTOCOL)) {
      if (condition->conditionValue.type != FWP_UINT8 || condition->conditionValue.uint8 != IPPROTO_TCP)
        return readback_mismatch("protocol");
      bit = 8;
    } else return readback_mismatch("unknown-condition");
    if ((seen & bit) != 0) return readback_mismatch("duplicate-condition");
    seen |= bit;
  }
  return seen == (UINT32)(allow ? 15 : 1);
}

static DWORD verify_filter_ids(const struct keiko_gateway_filters *filters, PSID sid,
                                UINT16 family, UINT16 port) {
  size_t index;
  for (index = 0; index < 3; index++) {
    FWPM_FILTER0 *filter = NULL;
    DWORD result = FwpmFilterGetById0(filters->engine, filters->ids[index], &filter);
    if (result != ERROR_SUCCESS) return result;
    const GUID *layer = index == 0 || (index == 2 && family == AF_INET)
                          ? &FWPM_LAYER_ALE_AUTH_CONNECT_V4 : &FWPM_LAYER_ALE_AUTH_CONNECT_V6;
    int valid = 1;
    if (filter == NULL) valid = readback_mismatch("missing-filter");
    else if (!same_guid(&filter->subLayerKey, &filters->sublayer)) valid = readback_mismatch("sublayer");
    else if (!same_guid(&filter->layerKey, layer)) valid = readback_mismatch("layer");
    /* BFE may mark a returned filter as indexed. That is a lookup optimization, not a policy
     * change. Reject every other flag, including disabled filters and hard-permit semantics. */
    else if ((filter->flags & ~(UINT32)FWPM_FILTER_FLAG_INDEXED) != 0)
      valid = readback_mismatch("flags");
    else if (filter->action.type != (UINT32)(index == 2 ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK))
      valid = readback_mismatch("action");
    else if (filter->weight.type != FWP_UINT64 || filter->weight.uint64 == NULL ||
             *filter->weight.uint64 != (UINT64)(index == 2 ? 2 : 1)) valid = readback_mismatch("weight");
    else valid = verify_conditions(filter, sid, family, port, index == 2);
    if (!valid) {
      FwpmFreeMemory0((void **)&filter);
      return ERROR_INVALID_DATA;
    }
    FwpmFreeMemory0((void **)&filter);
  }
  return ERROR_SUCCESS;
}

static DWORD install_transaction(struct keiko_gateway_filters *filters, PSID sid,
                                  UINT16 family, UINT16 port) {
  FWPM_SUBLAYER0 sublayer = {0};
  DWORD result = FwpmTransactionBegin0(filters->engine, 0);
  if (result != ERROR_SUCCESS) return result;
  sublayer.subLayerKey = filters->sublayer;
  sublayer.displayData.name = L"Keiko runtime tree gateway confinement";
  sublayer.weight = 0x7fff;
  result = FwpmSubLayerAdd0(filters->engine, &sublayer, NULL);
  if (result == ERROR_SUCCESS)
    result = add_package_block(filters, sid, &FWPM_LAYER_ALE_AUTH_CONNECT_V4, &filters->ids[0]);
  if (result == ERROR_SUCCESS)
    result = add_package_block(filters, sid, &FWPM_LAYER_ALE_AUTH_CONNECT_V6, &filters->ids[1]);
  if (result == ERROR_SUCCESS) result = add_gateway_allow(filters, sid, family, port);
  if (result == ERROR_SUCCESS) result = FwpmTransactionCommit0(filters->engine);
  else (void)FwpmTransactionAbort0(filters->engine);
  if (result == ERROR_SUCCESS) result = verify_filter_ids(filters, sid, family, port);
  return result;
}

DWORD keiko_gateway_filters_close(struct keiko_gateway_filters *filters) {
  DWORD result;
  if (filters == NULL) return ERROR_INVALID_PARAMETER;
  if (filters->engine == NULL) return ERROR_SUCCESS;
  result = FwpmEngineClose0(filters->engine);
  if (result == ERROR_SUCCESS) memset(filters, 0, sizeof(*filters));
  return result;
}

DWORD keiko_gateway_filters_open(PSID package_sid, UINT16 family, UINT16 port,
                                struct keiko_gateway_filters *filters) {
  FWPM_SESSION0 session = {0};
  DWORD result;
  if (filters == NULL || filters->engine != NULL || !package_sid_valid(package_sid) ||
      (family != AF_INET && family != AF_INET6) || port == 0) return ERROR_INVALID_PARAMETER;
  memset(filters, 0, sizeof(*filters));
  result = UuidCreate(&filters->sublayer);
  if (result != RPC_S_OK && result != RPC_S_UUID_LOCAL_ONLY) return result;
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.txnWaitTimeoutInMSec = 5000;
  result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, &filters->engine);
  if (result != ERROR_SUCCESS) return result;
  result = install_transaction(filters, package_sid, family, port);
  if (result != ERROR_SUCCESS) {
    DWORD cleanup = keiko_gateway_filters_close(filters);
    if (cleanup != ERROR_SUCCESS) return cleanup;
  }
  return result;
}

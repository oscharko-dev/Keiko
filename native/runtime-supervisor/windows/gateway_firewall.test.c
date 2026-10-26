/* Disposable-runner experiment only: an exact inbound desktop-AppContainer firewall rule.
 * No production integration or local default invocation. Remove and read back every created rule. */
#define COBJMACROS
#include "gateway_wfp.h"
#include <netfw.h>
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>

struct gateway_firewall_fixture {
  INetFwPolicy2 *policy;
  INetFwRules *rules;
  BSTR name;
  int initialized;
  int installed;
};

DWORD gateway_firewall_close(struct gateway_firewall_fixture *owner) {
  HRESULT result = S_OK;
  if (owner == NULL) return ERROR_SUCCESS;
  if (owner->installed) {
    INetFwRule *remaining = NULL;
    result = INetFwRules_Remove(owner->rules, owner->name);
    if (result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) result = S_OK;
    if (SUCCEEDED(result)) {
      HRESULT found = INetFwRules_Item(owner->rules, owner->name, &remaining);
      if (remaining != NULL) INetFwRule_Release(remaining);
      if (found != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) result = E_UNEXPECTED;
    }
  }
  if (owner->rules != NULL) INetFwRules_Release(owner->rules);
  if (owner->policy != NULL) INetFwPolicy2_Release(owner->policy);
  SysFreeString(owner->name);
  if (owner->initialized) CoUninitialize();
  free(owner);
  printf("socket-inbound-firewall-cleanup: code=%lu\n", (DWORD)result);
  return (DWORD)result;
}

DWORD gateway_firewall_open(PSID sid, const wchar_t *executable, UINT16 family, UINT16 port,
                             struct gateway_firewall_fixture **owned) {
  struct gateway_firewall_fixture *owner;
  INetFwRule3 *rule = NULL;
  INetFwRule *existing = NULL;
  UUID id;
  RPC_WSTR id_text = NULL;
  LPWSTR sid_text = NULL;
  wchar_t name[100], port_text[6];
  BSTR package = NULL, application = NULL, address = NULL, local_port = NULL;
  HRESULT result;
  DWORD status;
  if (sid == NULL || !IsValidSid(sid) || executable == NULL || port == 0 ||
      (family != AF_INET && family != AF_INET6) || owned == NULL || *owned != NULL)
    return ERROR_INVALID_PARAMETER;
  owner = calloc(1, sizeof(*owner));
  if (owner == NULL) return ERROR_OUTOFMEMORY;
  result = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(result)) goto done;
  owner->initialized = 1;
  status = UuidCreate(&id);
  if (status != RPC_S_OK && status != RPC_S_UUID_LOCAL_ONLY) { result = HRESULT_FROM_WIN32(status); goto done; }
  status = UuidToStringW(&id, &id_text);
  if (status != RPC_S_OK) { result = HRESULT_FROM_WIN32(status); goto done; }
  if (!ConvertSidToStringSidW(sid, &sid_text)) { result = HRESULT_FROM_WIN32(GetLastError()); goto done; }
  if (_snwprintf_s(name, 100, _TRUNCATE, L"Keiko.Gateway.Inbound.Fixture.%ls", id_text) < 0 ||
      _snwprintf_s(port_text, 6, _TRUNCATE, L"%u", (unsigned)port) < 0) { result = E_INVALIDARG; goto done; }
  owner->name = SysAllocString(name);
  package = SysAllocString(sid_text);
  application = SysAllocString(executable);
  address = SysAllocString(family == AF_INET ? L"127.0.0.1" : L"::1");
  local_port = SysAllocString(port_text);
  if (owner->name == NULL || package == NULL || application == NULL || address == NULL || local_port == NULL) {
    result = E_OUTOFMEMORY; goto done;
  }
  result = CoCreateInstance(&CLSID_NetFwPolicy2, NULL, CLSCTX_INPROC_SERVER, &IID_INetFwPolicy2,
                             (void **)&owner->policy);
  if (SUCCEEDED(result)) result = INetFwPolicy2_get_Rules(owner->policy, &owner->rules);
  if (SUCCEEDED(result)) {
    result = INetFwRules_Item(owner->rules, owner->name, &existing);
    if (result != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) { result = E_UNEXPECTED; goto done; }
    result = CoCreateInstance(&CLSID_NetFwRule, NULL, CLSCTX_INPROC_SERVER, &IID_INetFwRule3, (void **)&rule);
  }
  if (SUCCEEDED(result)) result = INetFwRule3_put_Name(rule, owner->name);
  if (SUCCEEDED(result)) result = INetFwRule3_put_LocalAppPackageId(rule, package);
  if (SUCCEEDED(result)) result = INetFwRule3_put_ApplicationName(rule, application);
  if (SUCCEEDED(result)) result = INetFwRule3_put_Direction(rule, NET_FW_RULE_DIR_IN);
  if (SUCCEEDED(result)) result = INetFwRule3_put_Protocol(rule, IPPROTO_TCP);
  if (SUCCEEDED(result)) result = INetFwRule3_put_LocalAddresses(rule, address);
  if (SUCCEEDED(result)) result = INetFwRule3_put_RemoteAddresses(rule, address);
  if (SUCCEEDED(result)) result = INetFwRule3_put_LocalPorts(rule, local_port);
  if (SUCCEEDED(result)) result = INetFwRule3_put_Profiles(rule, NET_FW_PROFILE2_ALL);
  if (SUCCEEDED(result)) result = INetFwRule3_put_EdgeTraversal(rule, VARIANT_FALSE);
  if (SUCCEEDED(result)) result = INetFwRule3_put_Action(rule, NET_FW_ACTION_ALLOW);
  if (SUCCEEDED(result)) result = INetFwRule3_put_Enabled(rule, VARIANT_TRUE);
  if (SUCCEEDED(result)) {
    /* An uncertain Add outcome still requires deletion/readback of our fresh name. */
    owner->installed = 1;
    result = INetFwRules_Add(owner->rules, (INetFwRule *)rule);
  }
done:
  if (existing != NULL) INetFwRule_Release(existing);
  if (rule != NULL) INetFwRule3_Release(rule);
  if (id_text != NULL) RpcStringFreeW(&id_text);
  if (sid_text != NULL) LocalFree(sid_text);
  SysFreeString(package); SysFreeString(application); SysFreeString(address); SysFreeString(local_port);
  if (SUCCEEDED(result)) *owned = owner;
  else (void)gateway_firewall_close(owner);
  printf("socket-inbound-firewall: code=%lu\n", (DWORD)result);
  return (DWORD)result;
}

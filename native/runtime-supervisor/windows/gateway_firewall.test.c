/* Disposable-runner experiment only: a package/program/user/port-scoped inbound firewall rule.
 * AppContainer admission and exact outbound confinement remain separate required controls.
 * No production integration or local default invocation. Remove/read back every created rule. */
#define COBJMACROS
#include "gateway_wfp.h"
#include <netfw.h>
#include <sddl.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct gateway_firewall_fixture {
  INetFwPolicy2 *policy;
  INetFwRules *rules;
  BSTR name;
  int initialized;
  int installed;
  HANDLE engine;
  GUID filter_key;
  FILETIME started;
};

/* NetSecurity rejects the IPv6 loopback address even for an exact /128 host.
 * The IPv6 fixture expresses the same scope directly in a private dynamic WFP session.
 * This soft permit cannot override a BLOCK in an independent sublayer. Same-sublayer
 * administrator-policy coexistence remains outside this disposable experiment. */
static UINT64 firewall_weight = ~(UINT64)0;
static FWP_BYTE_ARRAY16 firewall_loopback6 = {{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}};

static void firewall6_spec(PSID sid, FWP_BYTE_BLOB *app, FWP_BYTE_BLOB *user, UINT16 port,
                          const GUID *key, FWPM_FILTER0 *filter, FWPM_FILTER_CONDITION0 c[8]) {
  memset(filter, 0, sizeof(*filter));
  memset(c, 0, 8 * sizeof(*c));
  filter->filterKey = *key;
  filter->displayData.name = L"Keiko exact IPv6 inbound firewall fixture";
  filter->layerKey = FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6;
  filter->subLayerKey = FWPM_SUBLAYER_MPSSVC_WF;
  filter->action.type = FWP_ACTION_PERMIT;
  filter->weight.type = FWP_UINT64;
  filter->weight.uint64 = &firewall_weight;
  filter->numFilterConditions = 8;
  filter->filterCondition = c;
  for (unsigned i = 0; i < 8; i++) c[i].matchType = FWP_MATCH_EQUAL;
  c[0].fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
  c[0].conditionValue.type = FWP_SID;
  c[0].conditionValue.sid = sid;
  c[1].fieldKey = FWPM_CONDITION_ALE_APP_ID;
  c[1].conditionValue.type = FWP_BYTE_BLOB_TYPE;
  c[1].conditionValue.byteBlob = app;
  c[2].fieldKey = FWPM_CONDITION_ALE_USER_ID;
  c[2].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
  c[2].conditionValue.sd = user;
  c[3].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
  c[3].conditionValue.type = FWP_UINT8;
  c[3].conditionValue.uint8 = IPPROTO_TCP;
  c[4].fieldKey = FWPM_CONDITION_IP_LOCAL_PORT;
  c[4].conditionValue.type = FWP_UINT16;
  c[4].conditionValue.uint16 = port;
  c[5].fieldKey = FWPM_CONDITION_IP_LOCAL_ADDRESS;
  c[6].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
  for (unsigned i = 5; i < 7; i++) {
    c[i].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
    c[i].conditionValue.byteArray16 = &firewall_loopback6;
  }
  c[7].fieldKey = FWPM_CONDITION_FLAGS;
  c[7].matchType = FWP_MATCH_FLAGS_ALL_SET;
  c[7].conditionValue.type = FWP_UINT32;
  c[7].conditionValue.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
}

static int firewall_blob_equal(const FWP_BYTE_BLOB *a, const FWP_BYTE_BLOB *b) {
  return a != NULL && b != NULL && a->size != 0 && a->size == b->size &&
    a->data != NULL && b->data != NULL && memcmp(a->data, b->data, a->size) == 0;
}

static int firewall6_matches(const FWPM_FILTER0 *actual, const FWPM_FILTER0 *expected) {
  unsigned seen = 0;
  if (actual == NULL || !IsEqualGUID(&actual->filterKey, &expected->filterKey) ||
      !IsEqualGUID(&actual->layerKey, &expected->layerKey) ||
      !IsEqualGUID(&actual->subLayerKey, &expected->subLayerKey) ||
      actual->action.type != FWP_ACTION_PERMIT || actual->providerKey != NULL ||
      (actual->flags & ~FWPM_FILTER_FLAG_INDEXED) != 0 ||
      actual->weight.type != FWP_UINT64 || actual->weight.uint64 == NULL ||
      *actual->weight.uint64 != firewall_weight || actual->numFilterConditions != 8 ||
      actual->filterCondition == NULL) return 0;
  for (unsigned i = 0; i < 8; i++) {
    const FWPM_FILTER_CONDITION0 *a = &actual->filterCondition[i];
    unsigned j;
    int match = 0;
    for (j = 0; j < 8; j++) if (IsEqualGUID(&a->fieldKey, &expected->filterCondition[j].fieldKey)) break;
    if (j == 8 || (seen & (1u << j)) != 0) return 0;
    const FWPM_FILTER_CONDITION0 *e = &expected->filterCondition[j];
    if (a->matchType != e->matchType || a->conditionValue.type != e->conditionValue.type) return 0;
    switch (a->conditionValue.type) {
      case FWP_SID: match = a->conditionValue.sid != NULL && IsValidSid(a->conditionValue.sid) &&
        EqualSid(a->conditionValue.sid, e->conditionValue.sid); break;
      case FWP_BYTE_BLOB_TYPE: match = firewall_blob_equal(a->conditionValue.byteBlob, e->conditionValue.byteBlob); break;
      case FWP_SECURITY_DESCRIPTOR_TYPE: match = firewall_blob_equal(a->conditionValue.sd, e->conditionValue.sd); break;
      case FWP_UINT8: match = a->conditionValue.uint8 == e->conditionValue.uint8; break;
      case FWP_UINT16: match = a->conditionValue.uint16 == e->conditionValue.uint16; break;
      case FWP_UINT32: match = a->conditionValue.uint32 == e->conditionValue.uint32; break;
      case FWP_BYTE_ARRAY16_TYPE: match = a->conditionValue.byteArray16 != NULL &&
        memcmp(a->conditionValue.byteArray16, e->conditionValue.byteArray16, sizeof(FWP_BYTE_ARRAY16)) == 0; break;
      default: break;
    }
    if (!match) return 0;
    seen |= 1u << j;
  }
  return seen == 255;
}

static DWORD firewall_app_id(const wchar_t *executable, FWP_BYTE_BLOB **app) {
  wchar_t *expanded = calloc(32768, sizeof(wchar_t));
  DWORD result, length;
  if (expanded == NULL) return ERROR_OUTOFMEMORY;
  length = GetLongPathNameW(executable, expanded, 32768);
  result = length == 0 ? GetLastError() : length >= 32768 ? ERROR_BUFFER_OVERFLOW : ERROR_SUCCESS;
  if (result == ERROR_SUCCESS) result = FwpmGetAppIdFromFileName0(expanded, app);
  free(expanded);
  return result;
}

/* Resolve both spellings of the real fixture image without installing any policy. */
static int firewall_app_id_tests(void) {
  wchar_t *path = calloc(32768, sizeof(wchar_t)), *short_path = calloc(32768, sizeof(wchar_t));
  FWP_BYTE_BLOB *app = NULL, *short_app = NULL;
  DWORD length;
  int ok = 0;
  if (path == NULL || short_path == NULL) goto done;
  length = GetModuleFileNameW(NULL, path, 32768);
  if (length == 0 || length >= 32768) goto done;
  length = GetShortPathNameW(path, short_path, 32768);
  if (length == 0 || length >= 32768) goto done;
  ok = firewall_app_id(path, &app) == ERROR_SUCCESS &&
    firewall_app_id(short_path, &short_app) == ERROR_SUCCESS && firewall_blob_equal(app, short_app);
done:
  if (app != NULL) FwpmFreeMemory0((void **)&app);
  if (short_app != NULL) FwpmFreeMemory0((void **)&short_app);
  free(path); free(short_path);
  puts(ok ? "gateway-firewall-image-alias: passed" : "gateway-firewall-image-alias: failed");
  return ok;
}

/* Pure readback regression: no engine session and no host firewall mutation. */
int gateway_firewall_spec_tests(void) {
  PSID sid = NULL;
  GUID key = {1, 0, 0, {0}};
  UINT8 app_data[] = {1, 2}, user_data[] = {3, 4};
  FWP_BYTE_BLOB app = {sizeof(app_data), app_data}, user = {sizeof(user_data), user_data};
  FWPM_FILTER0 expected, actual;
  FWPM_FILTER_CONDITION0 e[8], a[8];
  int ok = 1;
  if (!ConvertStringSidToSidW(L"S-1-15-2-1-2-3-4-5-6-7", &sid)) return 1;
  firewall6_spec(sid, &app, &user, 45678, &key, &expected, e);
  for (unsigned mutation = 0; mutation < 22; mutation++) {
    actual = expected; memcpy(a, e, sizeof(a)); actual.filterCondition = a;
    if (mutation >= 1 && mutation <= 8) a[mutation - 1].conditionValue.type = FWP_EMPTY;
    if (mutation == 9) actual.flags = FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT;
    if (mutation == 10) actual.numFilterConditions--;
    if (mutation == 11) a[6] = a[5];
    if (mutation == 12) actual.subLayerKey = FWPM_SUBLAYER_UNIVERSAL;
    if (mutation == 13) actual.layerKey = FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4;
    if (mutation == 14) actual.providerKey = &key;
    if (mutation == 15) actual.filterKey.Data1++;
    if (mutation == 16) a[4].conditionValue.uint16++;
    if (mutation == 17) a[1].conditionValue.byteBlob = &user;
    if (mutation == 18) a[2].conditionValue.sd = &app;
    if (mutation == 19) a[7].matchType = FWP_MATCH_FLAGS_ANY_SET;
    if (mutation == 20) actual.weight.uint64 = NULL;
    if (mutation == 21) actual.flags = FWPM_FILTER_FLAG_INDEXED;
    if (firewall6_matches(&actual, &expected) != (mutation == 0 || mutation == 21)) ok = 0;
  }
  LocalFree(sid);
  puts(ok ? "gateway-firewall-exact-readback: passed" : "gateway-firewall-exact-readback: failed");
  return ok && firewall_app_id_tests() ? 0 : 1;
}

static DWORD firewall_user_descriptor(PSID user, PSID package, PSECURITY_DESCRIPTOR *sd) {
  LPWSTR user_text = NULL, package_text = NULL;
  wchar_t sddl[512];
  DWORD result = ERROR_SUCCESS;
  if (!ConvertSidToStringSidW(user, &user_text)) return GetLastError();
  if (package != NULL && !ConvertSidToStringSidW(package, &package_text)) {
    result = GetLastError(); goto done;
  }
  /* AppContainer checks the ordinary user and package portions separately. Granting
   * only the user denies the intended child; granting only the package is insufficient.
   * The separate ALE_PACKAGE_ID condition also excludes non-AppContainer tokens. */
  if (_snwprintf_s(sddl, 512, _TRUNCATE, L"O:%lsG:%lsD:(A;;CC;;;%ls)%ls%ls%ls",
      user_text, user_text, user_text, package_text == NULL ? L"" : L"(A;;CC;;;",
      package_text == NULL ? L"" : package_text, package_text == NULL ? L"" : L")") < 0)
    result = ERROR_BUFFER_OVERFLOW;
  else if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, sd, NULL))
    result = GetLastError();
done:
  LocalFree(user_text);
  if (package_text != NULL) LocalFree(package_text);
  return result;
}

/* Exercise the actual AppContainer token before it resumes. No WFP or network calls.
 * Both halves of an AppContainer access check must match: user AND package. */
int gateway_firewall_user_tests(HANDLE process, PSID package) {
  HANDLE token = NULL, impersonation = NULL;
  BYTE user_storage[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  TOKEN_USER *user = (TOKEN_USER *)user_storage;
  DWORD bytes = 0;
  PSID foreign_user = NULL, foreign_package = NULL;
  int ok = 0;
  GENERIC_MAPPING mapping = {1, 1, 1, 1};
  if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &token) ||
      !DuplicateToken(token, SecurityImpersonation, &impersonation) ||
      !GetTokenInformation(token, TokenUser, user, sizeof(user_storage), &bytes) ||
      !ConvertStringSidToSidW(L"S-1-5-21-1-2-3-12345", &foreign_user) ||
      !ConvertStringSidToSidW(L"S-1-15-2-1-2-3-4-5-6-7", &foreign_package)) goto done;
  ok = 1;
  for (unsigned variant = 0; variant < 4; variant++) {
    PSECURITY_DESCRIPTOR sd = NULL;
    BYTE privileges[1024];
    DWORD privilege_bytes = sizeof(privileges), granted = 0, result;
    BOOL allowed = FALSE;
    result = firewall_user_descriptor(variant == 1 ? foreign_user : user->User.Sid,
      variant == 2 ? foreign_package : variant == 3 ? NULL : package, &sd);
    if (result == ERROR_SUCCESS && !AccessCheck(sd, impersonation, FWP_ACTRL_MATCH_FILTER,
        &mapping, (PPRIVILEGE_SET)privileges, &privilege_bytes, &granted, &allowed)) result = GetLastError();
    if (result != ERROR_SUCCESS || (allowed != FALSE) != (variant == 0)) ok = 0;
    printf("gateway-firewall-user-binding: variant=%u code=%lu allowed=%d\n", variant, result, allowed != FALSE);
    if (sd != NULL) LocalFree(sd);
  }
done:
  if (foreign_user != NULL) LocalFree(foreign_user);
  if (foreign_package != NULL) LocalFree(foreign_package);
  if (impersonation != NULL) CloseHandle(impersonation);
  if (token != NULL) CloseHandle(token);
  return ok ? 0 : 1;
}

static DWORD firewall6_open(PSID sid, const wchar_t *executable, UINT16 port,
                           struct gateway_firewall_fixture *owner) {
  HANDLE token = NULL;
  TOKEN_USER *user = NULL;
  DWORD bytes = 0, result = ERROR_SUCCESS;
  PSECURITY_DESCRIPTOR sd = NULL;
  FWP_BYTE_BLOB user_blob = {0}, *app = NULL;
  FWPM_SESSION0 session = {0};
  FWPM_FILTER0 filter, *installed = NULL;
  FWPM_FILTER_CONDITION0 conditions[8];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
  if (bytes == 0) { result = ERROR_INVALID_DATA; goto done; }
  user = malloc(bytes);
  if (user == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (!GetTokenInformation(token, TokenUser, user, bytes, &bytes)) { result = GetLastError(); goto done; }
  result = firewall_user_descriptor(user->User.Sid, sid, &sd);
  if (result != ERROR_SUCCESS) goto done;
  user_blob.size = GetSecurityDescriptorLength(sd); user_blob.data = (UINT8 *)sd;
  result = firewall_app_id(executable, &app);
  if (result != ERROR_SUCCESS) goto done;
  result = UuidCreate(&owner->filter_key);
  if (result == RPC_S_UUID_LOCAL_ONLY) result = ERROR_SUCCESS;
  GetSystemTimeAsFileTime(&owner->started);
  session.flags = FWPM_SESSION_FLAG_DYNAMIC; session.txnWaitTimeoutInMSec = 5000;
  if (result == ERROR_SUCCESS) result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, &owner->engine);
  firewall6_spec(sid, app, &user_blob, port, &owner->filter_key, &filter, conditions);
  if (result == ERROR_SUCCESS) result = FwpmFilterAdd0(owner->engine, &filter, NULL, NULL);
  if (result == ERROR_SUCCESS) result = FwpmFilterGetByKey0(owner->engine, &owner->filter_key, &installed);
  if (result == ERROR_SUCCESS && !firewall6_matches(installed, &filter)) result = ERROR_INVALID_DATA;
done:
  if (installed != NULL) FwpmFreeMemory0((void **)&installed);
  if (app != NULL) FwpmFreeMemory0((void **)&app);
  if (sd != NULL) LocalFree(sd);
  free(user);
  CloseHandle(token);
  return result;
}

static void firewall6_event_matches(const FWPM_FILTER0 *filter, const FWPM_NET_EVENT2 *event) {
  unsigned matched = 0;
  const FWPM_NET_EVENT_HEADER2 *h = &event->header;
  if (event->type != FWPM_NET_EVENT_TYPE_CLASSIFY_DROP || event->classifyDrop == NULL ||
      h->ipVersion != FWP_IP_VERSION_V6) return;
  for (UINT32 i = 0; i < filter->numFilterConditions; i++) {
    const FWPM_FILTER_CONDITION0 *c = &filter->filterCondition[i];
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID) &&
        h->packageSid != NULL && EqualSid(h->packageSid, c->conditionValue.sid)) matched |= 1;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_APP_ID) &&
        firewall_blob_equal(&h->appId, c->conditionValue.byteBlob)) matched |= 2;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_USER_ID)) {
      PACL dacl = NULL; BOOL present = FALSE, defaulted = FALSE; void *ace = NULL;
      if (GetSecurityDescriptorDacl(c->conditionValue.sd->data, &present, &dacl, &defaulted) &&
          present && dacl != NULL && dacl->AceCount >= 1 && GetAce(dacl, 0, &ace) &&
          h->userId != NULL && EqualSid(h->userId, &((ACCESS_ALLOWED_ACE *)ace)->SidStart)) matched |= 4;
    }
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_PROTOCOL) &&
        h->ipProtocol == c->conditionValue.uint8) matched |= 8;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_LOCAL_PORT) &&
        h->localPort == c->conditionValue.uint16) matched |= 16;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_LOCAL_ADDRESS) &&
        memcmp(&h->localAddrV6, c->conditionValue.byteArray16, sizeof(FWP_BYTE_ARRAY16)) == 0) matched |= 32;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_REMOTE_ADDRESS) &&
        memcmp(&h->remoteAddrV6, c->conditionValue.byteArray16, sizeof(FWP_BYTE_ARRAY16)) == 0) matched |= 64;
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_FLAGS) && event->classifyDrop->isLoopback) matched |= 128;
  }
  printf("socket-firewall-event-match: mask=%u header-flags=%lu layer=%u\n", matched,
    h->flags, (unsigned)event->classifyDrop->layerId);
}

/* Bounded, body-free diagnostics for an exact installed fixture rule. */
void gateway_firewall_diagnose(struct gateway_firewall_fixture *owner, HANDLE child) {
  FWPM_FILTER0 *filter = NULL;
  HANDLE token = NULL, impersonation = NULL;
  DWORD result, access = 0, privilege_bytes = 1024;
  BYTE privileges[1024];
  BOOL allowed = FALSE;
  GENERIC_MAPPING mapping = {FWP_ACTRL_MATCH_FILTER, FWP_ACTRL_MATCH_FILTER,
    FWP_ACTRL_MATCH_FILTER, FWP_ACTRL_MATCH_FILTER};
  if (owner == NULL || owner->engine == NULL) return;
  result = FwpmFilterGetByKey0(owner->engine, &owner->filter_key, &filter);
  if (result != ERROR_SUCCESS) return;
  for (UINT32 i = 0; i < filter->numFilterConditions; i++) {
    FWPM_FILTER_CONDITION0 *c = &filter->filterCondition[i];
    if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_USER_ID)) {
      if (!OpenProcessToken(child, TOKEN_QUERY | TOKEN_DUPLICATE, &token) ||
          !DuplicateToken(token, SecurityImpersonation, &impersonation) ||
          !AccessCheck(c->conditionValue.sd->data, impersonation, FWP_ACTRL_MATCH_FILTER,
            &mapping, (PPRIVILEGE_SET)privileges, &privilege_bytes, &access, &allowed)) result = GetLastError();
      printf("socket-firewall-user-access: code=%lu allowed=%d\n", result, allowed != FALSE);
    }
  }
  {
    FWPM_NET_EVENT_ENUM_TEMPLATE0 query = {0};
    FWPM_FILTER_CONDITION0 app_condition = {0};
    HANDLE enumeration = NULL;
    FWPM_NET_EVENT2 **events = NULL;
    UINT32 count = 0;
    query.startTime = owner->started; GetSystemTimeAsFileTime(&query.endTime);
    for (UINT32 i = 0; i < filter->numFilterConditions; i++)
      if (IsEqualGUID(&filter->filterCondition[i].fieldKey, &FWPM_CONDITION_ALE_APP_ID))
        app_condition = filter->filterCondition[i];
    query.numFilterConditions = 1; query.filterCondition = &app_condition;
    result = FwpmNetEventCreateEnumHandle0(owner->engine, &query, &enumeration);
    if (result == ERROR_SUCCESS) {
      result = FwpmNetEventEnum2(owner->engine, enumeration, 32, &events, &count);
      if (result == ERROR_SUCCESS)
        for (UINT32 i = 0; i < count; i++) firewall6_event_matches(filter, events[i]);
      if (events != NULL) FwpmFreeMemory0((void **)&events);
      (void)FwpmNetEventDestroyEnumHandle0(owner->engine, enumeration);
    }
    printf("socket-firewall-event-read: code=%lu count=%u\n", result, (unsigned)count);
  }
  if (impersonation != NULL) CloseHandle(impersonation);
  if (token != NULL) CloseHandle(token);
  FwpmFreeMemory0((void **)&filter);
}

static DWORD firewall6_close(struct gateway_firewall_fixture *owner) {
  HANDLE observer = NULL;
  FWPM_FILTER0 *remaining = NULL;
  DWORD result = FwpmEngineClose0(owner->engine), found;
  if (result != ERROR_SUCCESS) return result;
  result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &observer);
  if (result != ERROR_SUCCESS) return result;
  found = FwpmFilterGetByKey0(observer, &owner->filter_key, &remaining);
  result = found == FWP_E_FILTER_NOT_FOUND ? ERROR_SUCCESS :
    found == ERROR_SUCCESS ? ERROR_INVALID_DATA : found;
  if (remaining != NULL) FwpmFreeMemory0((void **)&remaining);
  found = FwpmEngineClose0(observer);
  return found == ERROR_SUCCESS ? result : found;
}

static DWORD install_package_rule(const wchar_t *name, const wchar_t *package,
                                   const wchar_t *application, UINT16 family, UINT16 port) {
  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION process = {0};
  SECURITY_ATTRIBUTES inheritable = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE job = NULL, null_io = INVALID_HANDLE_VALUE;
  wchar_t powershell[MAX_PATH], *script = NULL, *command = NULL, *separator;
  DWORD result = ERROR_SUCCESS, length, code = 1;
  SIZE_T bytes = 0;
  int initialized = 0;
  script = calloc(32768, sizeof(wchar_t));
  command = calloc(32768, sizeof(wchar_t));
  if (script == NULL || command == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  length = GetModuleFileNameW(NULL, script, 32768);
  if (length == 0 || length >= 32768) { result = ERROR_BUFFER_OVERFLOW; goto done; }
  separator = wcsrchr(script, L'\\');
  if (separator == NULL) { result = ERROR_INVALID_NAME; goto done; }
  separator[1] = L'\0';
  length = GetSystemDirectoryW(powershell, MAX_PATH);
  if (length == 0 || length >= MAX_PATH ||
      wcscat_s(powershell, MAX_PATH, L"\\WindowsPowerShell\\v1.0\\powershell.exe") != 0 ||
      wcscat_s(script, 32768, L"gateway-firewall.ps1") != 0 ||
      wcschr(application, L'\"') != NULL ||
      _snwprintf_s(command, 32768, _TRUNCATE,
        L"\"%ls\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%ls\" "
        L"-RuleName %ls -PackageSid %ls -Program \"%ls\" -Family %u -Port %u",
        powershell, script, name, package, application, (unsigned)family, (unsigned)port) < 0) {
    result = ERROR_BUFFER_OVERFLOW; goto done;
  }
  /* A fixed script and bounded scalar arguments; no command-string evaluation. Suppress output
   * containing private identities. The process-only policy does not alter machine configuration. */
  null_io = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         &inheritable, OPEN_EXISTING, 0, NULL);
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = calloc(1, bytes);
  if (startup.lpAttributeList == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (null_io == INVALID_HANDLE_VALUE ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
    result = GetLastError(); goto done;
  }
  initialized = 1;
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_io;
  startup.StartupInfo.hStdOutput = null_io;
  startup.StartupInfo.hStdError = null_io;
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL ||
      !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  &null_io, sizeof(null_io), NULL, NULL) ||
      !CreateProcessW(powershell, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL,
        &startup.StartupInfo, &process) || !AssignProcessToJobObject(job, process.hProcess) ||
      ResumeThread(process.hThread) == (DWORD)-1) { result = GetLastError(); goto done; }
  if (WaitForSingleObject(process.hProcess, 30000) != WAIT_OBJECT_0) result = ERROR_TIMEOUT;
  else if (!GetExitCodeProcess(process.hProcess, &code)) result = GetLastError();
  else result = code;
done:
  if (process.hProcess != NULL) {
    if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0 &&
        !TerminateProcess(process.hProcess, 1)) result = GetLastError();
    if (job != NULL && !TerminateJobObject(job, 1)) result = GetLastError();
    if (WaitForSingleObject(process.hProcess, 5000) != WAIT_OBJECT_0) result = ERROR_TIMEOUT;
    CloseHandle(process.hProcess);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (job != NULL) CloseHandle(job);
  if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (null_io != INVALID_HANDLE_VALUE) CloseHandle(null_io);
  free(script); free(command);
  return result;
}

DWORD gateway_firewall_close(struct gateway_firewall_fixture *owner) {
  HRESULT result = S_OK;
  if (owner == NULL) return ERROR_SUCCESS;
  if (owner->engine != NULL) result = (HRESULT)firewall6_close(owner);
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
  INetFwRule *existing = NULL;
  UUID id;
  RPC_WSTR id_text = NULL;
  LPWSTR package_text = NULL;
  DWORD length;
  wchar_t *expanded = NULL;
  wchar_t name[100];
  HRESULT result;
  DWORD status;
  if (sid == NULL || !IsValidSid(sid) || executable == NULL || port == 0 ||
      (family != AF_INET && family != AF_INET6) || owned == NULL || *owned != NULL)
    return ERROR_INVALID_PARAMETER;
  owner = calloc(1, sizeof(*owner));
  if (owner == NULL) return ERROR_OUTOFMEMORY;
  if (family == AF_INET6) {
    result = HRESULT_FROM_WIN32(firewall6_open(sid, executable, port, owner));
    goto done;
  }
  result = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(result)) goto done;
  owner->initialized = 1;
  status = UuidCreate(&id);
  if (status != RPC_S_OK && status != RPC_S_UUID_LOCAL_ONLY) { result = HRESULT_FROM_WIN32(status); goto done; }
  status = UuidToStringW(&id, &id_text);
  if (status != RPC_S_OK) { result = HRESULT_FROM_WIN32(status); goto done; }
  if (!ConvertSidToStringSidW(sid, &package_text)) {
    result = HRESULT_FROM_WIN32(GetLastError()); goto done;
  }
  expanded = calloc(32768, sizeof(wchar_t));
  if (expanded == NULL) { result = E_OUTOFMEMORY; goto done; }
  length = GetLongPathNameW(executable, expanded, 32768);
  if (length == 0 || length >= 32768) {
    result = HRESULT_FROM_WIN32(length == 0 ? GetLastError() : ERROR_BUFFER_OVERFLOW); goto done;
  }
  if (_snwprintf_s(name, 100, _TRUNCATE, L"Keiko.Gateway.Inbound.Fixture.%ls", id_text) < 0) {
    result = E_INVALIDARG; goto done;
  }
  owner->name = SysAllocString(name);
  if (owner->name == NULL) {
    result = E_OUTOFMEMORY; goto done;
  }
  result = CoCreateInstance(&CLSID_NetFwPolicy2, NULL, CLSCTX_INPROC_SERVER, &IID_INetFwPolicy2,
                             (void **)&owner->policy);
  if (SUCCEEDED(result)) result = INetFwPolicy2_get_Rules(owner->policy, &owner->rules);
  if (SUCCEEDED(result)) {
    result = INetFwRules_Item(owner->rules, owner->name, &existing);
    if (result != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) { result = E_UNEXPECTED; goto done; }
    /* INetFwRules::Add excludes LocalAppPackageId. NetSecurity's documented Package parameter
     * creates the complete rule; COM is used only for exact-name absence checks and cleanup. */
    owner->installed = 1;
    status = install_package_rule(name, package_text, expanded, family, port);
    result = HRESULT_FROM_WIN32(status);
  }
done:
  if (existing != NULL) INetFwRule_Release(existing);
  if (id_text != NULL) RpcStringFreeW(&id_text);
  if (package_text != NULL) LocalFree(package_text);
  free(expanded);
  if (SUCCEEDED(result)) *owned = owner;
  else {
    DWORD closed = gateway_firewall_close(owner);
    if (closed != ERROR_SUCCESS) result = HRESULT_FROM_WIN32(closed);
  }
  printf("socket-inbound-firewall: code=%lu\n", (DWORD)result);
  return (DWORD)result;
}

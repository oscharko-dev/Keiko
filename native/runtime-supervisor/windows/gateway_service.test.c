/* Independently observe the suspended root in the supervisor's named job. The other
 * invocation runs inside that job and emits the first observable child instruction. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>
#include <networkisolation.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static DWORD observed_root(void) {
  for (int i = 0; i < 200; i++) {
    HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE,
        L"Local\\KeikoRuntime-0123456789abcdef0123456789abcdef");
    if (job) {
      JOBOBJECT_BASIC_PROCESS_ID_LIST ids = {0};
      BOOL found = QueryInformationJobObject(job, JobObjectBasicProcessIdList, &ids,
          sizeof(ids), NULL) && ids.NumberOfProcessIdsInList == 1;
      CloseHandle(job);
      if (found) return (DWORD)ids.ProcessIdList[0];
    }
    Sleep(10);
  }
  return 0;
}

/* Query BFE independently of broker state, for the actual job root's package SID. */
static int installed_filters(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  HANDLE token = NULL, engine = NULL, enumeration = NULL;
  BYTE info[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE];
  DWORD bytes, seen = 0;
  int ok = 0;
  if (!process || !OpenProcessToken(process, TOKEN_QUERY, &token) ||
      !GetTokenInformation(token, TokenAppContainerSid, info, sizeof(info), &bytes) ||
      FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &engine) != ERROR_SUCCESS ||
      FwpmFilterCreateEnumHandle0(engine, NULL, &enumeration) != ERROR_SUCCESS) goto done;
  PSID sid = ((TOKEN_APPCONTAINER_INFORMATION *)info)->TokenAppContainer;
  if (!sid || !IsValidSid(sid)) goto done;
  for (;;) {
    FWPM_FILTER0 **entries = NULL;
    UINT32 count;
    if (FwpmFilterEnum0(engine, enumeration, 128, &entries, &count) != ERROR_SUCCESS) goto done;
    for (UINT32 i = 0; i < count; i++) {
      FWPM_FILTER0 *f = entries[i];
      BOOL package = FALSE, loopback = FALSE, port = FALSE, tcp = FALSE;
      for (UINT32 j = 0; j < f->numFilterConditions; j++) {
        FWPM_FILTER_CONDITION0 *c = &f->filterCondition[j];
        if (c->matchType != FWP_MATCH_EQUAL) continue;
        if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_ALE_PACKAGE_ID) &&
            c->conditionValue.type == FWP_SID) package = EqualSid(c->conditionValue.sid, sid);
        if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_REMOTE_ADDRESS) &&
            c->conditionValue.type == FWP_UINT32) loopback = c->conditionValue.uint32 == INADDR_LOOPBACK;
        if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_REMOTE_PORT) &&
            c->conditionValue.type == FWP_UINT16) port = c->conditionValue.uint16 == 1;
        if (IsEqualGUID(&c->fieldKey, &FWPM_CONDITION_IP_PROTOCOL) &&
            c->conditionValue.type == FWP_UINT8) tcp = c->conditionValue.uint8 == IPPROTO_TCP;
      }
      if (!package || (f->flags & FWPM_FILTER_FLAG_DISABLED)) continue;
      BOOL v4 = IsEqualGUID(&f->layerKey, &FWPM_LAYER_ALE_AUTH_CONNECT_V4);
      BOOL v6 = IsEqualGUID(&f->layerKey, &FWPM_LAYER_ALE_AUTH_CONNECT_V6);
      if (f->action.type == FWP_ACTION_BLOCK && f->numFilterConditions == 1 &&
          (f->flags & FWPM_FILTER_FLAG_PERSISTENT)) seen |= v4 ? 1 : v6 ? 2 : 0;
      if (f->action.type == FWP_ACTION_PERMIT && v4 && loopback && port && tcp &&
          f->numFilterConditions == 4) seen |= 4;
    }
    if (entries) FwpmFreeMemory0((void **)&entries);
    if (count < 128) break;
  }
  ok = seen == 7;
done:
  if (enumeration) FwpmFilterDestroyEnumHandle0(engine, enumeration);
  if (engine) FwpmEngineClose0(engine);
  if (token) CloseHandle(token);
  if (process) CloseHandle(process);
  return ok;
}

/* Bound the connect attempt and report Winsock's verdict. A successful send is
 * independently observed at the host listener, not inferred from the filter table. */
static int send_probe(const wchar_t *port_text, char marker) {
  wchar_t *end;
  unsigned long port = wcstoul(port_text, &end, 10);
  if (*end || !port || port > 65535) return WSAEINVAL;
  SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (client == INVALID_SOCKET) return WSAGetLastError();
  WSAEVENT event = WSACreateEvent();
  int result = 0;
  SOCKADDR_IN address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((u_short)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (event == WSA_INVALID_EVENT || WSAEventSelect(client, event, FD_CONNECT)) {
    result = WSAGetLastError();
  } else if (connect(client, (SOCKADDR *)&address, sizeof(address))) {
    result = WSAGetLastError();
    if (result == WSAEWOULDBLOCK) {
      WSANETWORKEVENTS events;
      DWORD wait = WSAWaitForMultipleEvents(1, &event, FALSE, 2500, FALSE);
      if (wait == WSA_WAIT_TIMEOUT) result = WSAETIMEDOUT;
      else if (wait != WSA_WAIT_EVENT_0 || WSAEnumNetworkEvents(client, event, &events))
        result = WSAGetLastError();
      else result = (events.lNetworkEvents & FD_CONNECT) ? events.iErrorCode[FD_CONNECT_BIT] : WSAEINVAL;
    }
  }
  if (!result && send(client, &marker, 1, 0) != 1) result = WSAGetLastError();
  closesocket(client);
  if (event != WSA_INVALID_EVENT) WSACloseEvent(event);
  return result;
}

static DWORD diagnose_loopback(NETISO_ERROR_TYPE *missing) {
  HMODULE firewall = LoadLibraryExW(L"FirewallAPI.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!firewall) return GetLastError();
  union {
    FARPROC address;
    DWORD (WINAPI *call)(LPCWSTR, NETISO_ERROR_TYPE *);
  } diagnosis;
  diagnosis.address = GetProcAddress(firewall, "NetworkIsolationDiagnoseConnectFailureAndGetInfo");
  DWORD result = diagnosis.address ? diagnosis.call(L"127.0.0.1", missing) : ERROR_PROC_NOT_FOUND;
  FreeLibrary(firewall);
  return result;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 5 && !wcscmp(argv[1], L"--probe-ports")) {
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data)) return 1;
    char marker = !wcscmp(argv[4], L"control") ? 'C' : 'T';
    int allowed = send_probe(argv[2], marker);
    NETISO_ERROR_TYPE missing = NETISO_ERROR_TYPE_NONE;
    DWORD diagnosis = allowed ? diagnose_loopback(&missing) : ERROR_SUCCESS;
    int hostile = send_probe(argv[3], marker);
    printf("{\"allowed\":%d,\"hostile\":%d,\"diagnosisStatus\":%lu,\"missingCapability\":%d}\n",
           allowed, hostile, diagnosis, (int)missing);
    WSACleanup();
    return 0;
  }
  if (argc == 1) {
    puts("child-entered");
    fflush(stdout);
    return getchar() == 'X' ? 0 : 1;
  }
  if (argc != 2) return 2;
  DWORD pid = observed_root();
  if (!pid) return 1;
  if (!wcscmp(argv[1], L"--observe")) return 0;
  return !wcscmp(argv[1], L"--inspect-filters") && installed_filters(pid) ? 0 : 1;
}

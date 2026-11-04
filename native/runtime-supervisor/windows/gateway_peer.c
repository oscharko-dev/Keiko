#include "gateway_peer.h"
#include <sddl.h>
#include <stdlib.h>
#include <string.h>

HANDLE keiko_gateway_service_pipe(const wchar_t *name) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, FALSE};
  /* AU may exchange messages and synchronize. Generic write would also grant
   * FILE_CREATE_PIPE_INSTANCE, allowing a client to impersonate the broker. */
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;GA;;;SY)(A;;0x0012008B;;;AU)", SDDL_REVISION_1, &descriptor, NULL))
    return INVALID_HANDLE_VALUE;
  security.lpSecurityDescriptor = descriptor;
  HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE |
      FILE_FLAG_OVERLAPPED, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT |
      PIPE_REJECT_REMOTE_CLIENTS, 1, 1024, 1024, 1000, &security);
  DWORD error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  LocalFree(descriptor);
  if (pipe == INVALID_HANDLE_VALUE) SetLastError(error);
  return pipe;
}

static DWORD token_identity(HANDLE token, TOKEN_STATISTICS *statistics, DWORD *session,
                            BYTE user[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]) {
  BYTE integrity[sizeof(TOKEN_MANDATORY_LABEL) + SECURITY_MAX_SID_SIZE];
  TOKEN_MANDATORY_LABEL *label = (TOKEN_MANDATORY_LABEL *)integrity;
  DWORD bytes = 0, appcontainer = 0;
  SID_IDENTIFIER_AUTHORITY mandatory = SECURITY_MANDATORY_LABEL_AUTHORITY;
  if (!GetTokenInformation(token, TokenStatistics, statistics, sizeof(*statistics), &bytes) ||
      !GetTokenInformation(token, TokenSessionId, session, sizeof(*session), &bytes) ||
      !GetTokenInformation(token, TokenUser, user, sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE, &bytes) ||
      !GetTokenInformation(token, TokenIsAppContainer, &appcontainer, sizeof(appcontainer), &bytes) ||
      !GetTokenInformation(token, TokenIntegrityLevel, integrity, sizeof(integrity), &bytes))
    return GetLastError();
  if (appcontainer || !IsValidSid(label->Label.Sid) ||
      *GetSidSubAuthorityCount(label->Label.Sid) != 1 ||
      memcmp(GetSidIdentifierAuthority(label->Label.Sid), &mandatory, sizeof(mandatory)) != 0 ||
      *GetSidSubAuthority(label->Label.Sid, 0) < SECURITY_MANDATORY_MEDIUM_RID)
    return ERROR_ACCESS_DENIED;
  return ERROR_SUCCESS;
}

static DWORD compare_tokens(HANDLE process_token, HANDLE pipe_token, DWORD pipe_session) {
  TOKEN_STATISTICS process_stats = {0}, pipe_stats = {0};
  DWORD process_session = 0, token_session = 0;
  BYTE process_user[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  BYTE pipe_user[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  DWORD result = token_identity(process_token, &process_stats, &process_session, process_user);
  if (result != ERROR_SUCCESS) return result;
  result = token_identity(pipe_token, &pipe_stats, &token_session, pipe_user);
  if (result != ERROR_SUCCESS) return result;
  if (process_session != pipe_session || token_session != pipe_session ||
      memcmp(&process_stats.AuthenticationId, &pipe_stats.AuthenticationId, sizeof(LUID)) != 0 ||
      !EqualSid(((TOKEN_USER *)process_user)->User.Sid, ((TOKEN_USER *)pipe_user)->User.Sid) ||
      pipe_stats.TokenType != TokenImpersonation || pipe_stats.ImpersonationLevel < SecurityIdentification)
    return ERROR_ACCESS_DENIED;
  return ERROR_SUCCESS;
}

static DWORD image_matches(HANDLE process, HANDLE approved_image) {
  FILE_ID_INFO expected = {0}, actual = {0};
  FILE_STANDARD_INFO standard = {0};
  DWORD length = 32768, result = ERROR_SUCCESS;
  wchar_t *path = calloc(length, sizeof(wchar_t));
  wchar_t *long_path = calloc(length, sizeof(wchar_t));
  wchar_t *approved_path = calloc(length, sizeof(wchar_t));
  HANDLE image = INVALID_HANDLE_VALUE;
  if (path == NULL || long_path == NULL || approved_path == NULL) { result = ERROR_OUTOFMEMORY; goto done; }
  if (!GetFileInformationByHandleEx(approved_image, FileIdInfo, &expected, sizeof(expected)) ||
      !GetFileInformationByHandleEx(approved_image, FileStandardInfo, &standard, sizeof(standard)) ||
      !QueryFullProcessImageNameW(process, 0, path, &length)) {
    result = GetLastError(); goto done;
  }
  if (standard.Directory || standard.DeletePending) { result = ERROR_ACCESS_DENIED; goto done; }
  /* The process image name may retain 8.3 components (including the hosted runner's TEMP).
   * Expand spelling only: GetLongPathName does not authorize a different junction/hardlink path. */
  length = GetLongPathNameW(path, long_path, 32768);
  if (length == 0 || length >= 32768) { result = ERROR_ACCESS_DENIED; goto done; }
  length = GetFinalPathNameByHandleW(approved_image, approved_path, 32768, FILE_NAME_NORMALIZED);
  /* Require the protected installation pathname as well as its file ID. Looking up an arbitrary
   * process-reported pathname would accept a hostile image renamed/replaced after it started. */
  if (length < 7 || length >= 32768 || wcsncmp(approved_path, L"\\\\?\\", 4) != 0 ||
      approved_path[5] != L':' || approved_path[6] != L'\\' ||
      CompareStringOrdinal(long_path, -1, approved_path + 4, -1, TRUE) != CSTR_EQUAL) {
    result = ERROR_ACCESS_DENIED; goto done;
  }
  image = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                       FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (image == INVALID_HANDLE_VALUE) { result = GetLastError(); goto done; }
  if (!GetFileInformationByHandleEx(image, FileIdInfo, &actual, sizeof(actual))) {
    result = GetLastError(); goto done;
  }
  if (memcmp(&actual, &expected, sizeof(actual)) != 0) result = ERROR_ACCESS_DENIED;
done:
  if (image != INVALID_HANDLE_VALUE) CloseHandle(image);
  free(path);
  free(long_path);
  free(approved_path);
  return result;
}

void keiko_gateway_peer_close(struct keiko_gateway_peer *peer) {
  if (peer == NULL) return;
  if (peer->token != NULL) CloseHandle(peer->token);
  if (peer->process != NULL) CloseHandle(peer->process);
  memset(peer, 0, sizeof(*peer));
}

DWORD keiko_gateway_peer_authenticate(HANDLE pipe, HANDLE approved_image,
                                      struct keiko_gateway_peer *peer) {
  struct keiko_gateway_peer authenticated = {0};
  HANDLE process_token = NULL;
  FILETIME exited, kernel, user;
  ULONG session = 0;
  DWORD result;
  if (peer == NULL || peer->process != NULL || peer->token != NULL ||
      approved_image == NULL || approved_image == INVALID_HANDLE_VALUE) return ERROR_INVALID_PARAMETER;
  if (!GetNamedPipeClientProcessId(pipe, &authenticated.pid) ||
      !GetNamedPipeClientSessionId(pipe, &session)) return GetLastError();
  authenticated.process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                       FALSE, authenticated.pid);
  if (authenticated.process == NULL) return GetLastError();
  result = image_matches(authenticated.process, approved_image);
  if (result != ERROR_SUCCESS) goto done;
  if (WaitForSingleObject(authenticated.process, 0) != WAIT_TIMEOUT) {
    result = ERROR_ACCESS_DENIED; goto done;
  }
  if (!GetProcessTimes(authenticated.process, &authenticated.created, &exited, &kernel, &user) ||
      !OpenProcessToken(authenticated.process, TOKEN_QUERY, &process_token)) {
    result = GetLastError(); goto done;
  }
  if (!ImpersonateNamedPipeClient(pipe)) { result = GetLastError(); goto done; }
  result = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                            TRUE, &authenticated.token) ? ERROR_SUCCESS : GetLastError();
  /* Never continue service work in an uncertain impersonation context. */
  if (!RevertToSelf()) ExitProcess(ERROR_CANNOT_IMPERSONATE);
  if (result == ERROR_SUCCESS) result = compare_tokens(process_token, authenticated.token, session);
done:
  if (process_token != NULL) CloseHandle(process_token);
  if (result == ERROR_SUCCESS) *peer = authenticated;
  else keiko_gateway_peer_close(&authenticated);
  return result;
}

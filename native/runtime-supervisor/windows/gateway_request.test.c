/* Bounded wire admission against vectors also checked by the actual TypeScript policy owner. */
#include "gateway_request.h"
#include <stdio.h>
#include <string.h>

static DWORD admit_fixture(const BYTE *bytes, DWORD size, struct keiko_gateway_request *request) {
  struct keiko_gateway_challenge challenge = {0};
  memset(challenge.nonce, 0x11, sizeof(challenge.nonce));
  challenge.issued = 1;
  return keiko_gateway_request_admit(&challenge, bytes, size, request);
}

static int rejects(const BYTE *bytes, DWORD size) {
  struct keiko_gateway_request request, before;
  memset(&request, 0x5a, sizeof(request));
  before = request;
  return admit_fixture(bytes, size, &request) != ERROR_SUCCESS &&
         memcmp(&request, &before, sizeof(request)) == 0;
}

int gateway_request_tests(const char *filename) {
  BYTE bytes[KEIKO_GATEWAY_OPEN_BYTES + 1], changed[KEIKO_GATEWAY_OPEN_BYTES + 1];
  struct keiko_gateway_challenge challenge = {0}, other = {0};
  struct keiko_gateway_request request = {0};
  FILE *input = NULL;
  size_t count, index;
  int ok = 0, read_failed;
  const size_t malformed_offsets[] = {0, 4, 6, 8, 90};
  const size_t digest_offsets[] = {92, 156, 220, 284, 348};
  if (fopen_s(&input, filename, "rb") != 0 || input == NULL) return 1;
  count = fread(bytes, 1, sizeof(bytes), input);
  read_failed = ferror(input);
  if (fclose(input) != 0 || read_failed || count != KEIKO_GATEWAY_OPEN_BYTES) return 1;
  bytes[KEIKO_GATEWAY_OPEN_BYTES] = 0;
  if (admit_fixture(bytes, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_SUCCESS ||
      request.port == 0 || request.run_id[0] == '\0' || request.job_handle != 4) goto done;
  for (index = 0; index < KEIKO_GATEWAY_OPEN_BYTES; index++)
    if (!rejects(bytes, (DWORD)index)) goto done;
  if (!rejects(bytes, sizeof(bytes)) || !rejects(NULL, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  for (index = 0; index < sizeof(malformed_offsets) / sizeof(malformed_offsets[0]); index++) {
    memcpy(changed, bytes, sizeof(bytes));
    changed[malformed_offsets[index]] ^= 0x01;
    if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  }
  /* Valid hex mutations must fail the policy digest, not just the alphabet check. */
  for (index = 0; index < sizeof(digest_offsets) / sizeof(digest_offsets[0]); index++) {
    memcpy(changed, bytes, sizeof(bytes));
    changed[digest_offsets[index]] = changed[digest_offsets[index]] == 'a' ? 'b' : 'a';
    if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  }
  for (index = 12; index < 44; index++) {
    memcpy(changed, bytes, sizeof(bytes)); changed[index] ^= 1;
    if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  }
  memcpy(changed, bytes, sizeof(bytes)); changed[86] ^= 1;
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[84] = changed[84] == AF_INET ? AF_INET6 : AF_INET;
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[412] = changed[412] == 'A' ? 'B' : 'A';
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[44] = 'A';
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); memset(changed + 76, 0, 8);
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memset(changed + 76, 0xff, 8);
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[88] = 129;
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[88] = 0;
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[412] = '.';
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  memcpy(changed, bytes, sizeof(bytes)); changed[413] = '"';
  if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  if (bytes[88] < 128) {
    memcpy(changed, bytes, sizeof(bytes)); changed[412 + bytes[88]] = 'A';
    if (!rejects(changed, KEIKO_GATEWAY_OPEN_BYTES)) goto done;
  }
  if (keiko_gateway_request_admit(&challenge, bytes, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_INVALID_STATE ||
      keiko_gateway_challenge_issue(NULL) != ERROR_INVALID_PARAMETER ||
      keiko_gateway_challenge_issue(&challenge) != ERROR_SUCCESS ||
      keiko_gateway_challenge_issue(&challenge) != ERROR_INVALID_PARAMETER ||
      keiko_gateway_challenge_issue(&other) != ERROR_SUCCESS ||
      memcmp(challenge.nonce, other.nonce, sizeof(challenge.nonce)) == 0) goto done;
  memcpy(changed, bytes, sizeof(bytes));
  memcpy(changed + 12, challenge.nonce, sizeof(challenge.nonce));
  if (keiko_gateway_request_admit(&challenge, changed, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_SUCCESS ||
      keiko_gateway_request_admit(&challenge, changed, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_INVALID_STATE ||
      keiko_gateway_challenge_issue(&challenge) != ERROR_INVALID_PARAMETER ||
      keiko_gateway_request_admit(&other, changed, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_INVALID_DATA ||
      keiko_gateway_request_admit(&other, changed, KEIKO_GATEWAY_OPEN_BYTES, &request) != ERROR_INVALID_STATE)
    goto done;
  memset(changed, 0, sizeof(challenge.nonce));
  if (memcmp(challenge.nonce, changed, sizeof(challenge.nonce)) != 0 ||
      memcmp(other.nonce, changed, sizeof(other.nonce)) != 0) goto done;
  ok = 1;
done:
  puts(ok ? "gateway-request-admission: passed" : "gateway-request-admission: failed");
  return ok ? 0 : 1;
}

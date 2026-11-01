#include "gateway_request.h"
#include "../../portable-launcher/keiko-portable-sha256.h"
#include <stdio.h>
#include <string.h>

static UINT16 request_u16(const BYTE *bytes) {
  return (UINT16)((UINT16)bytes[0] | ((UINT16)bytes[1] << 8));
}

static UINT32 request_u32(const BYTE *bytes) {
  return (UINT32)bytes[0] | ((UINT32)bytes[1] << 8) | ((UINT32)bytes[2] << 16) |
         ((UINT32)bytes[3] << 24);
}

static int lower_hex(const BYTE *bytes, size_t size) {
  size_t index;
  for (index = 0; index < size; index++)
    if (!((bytes[index] >= '0' && bytes[index] <= '9') ||
          (bytes[index] >= 'a' && bytes[index] <= 'f'))) return 0;
  return 1;
}

static int run_character(BYTE byte) {
  return (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
         (byte >= '0' && byte <= '9');
}

static int request_run_id(const BYTE *bytes, UINT16 size) {
  size_t index;
  if (size == 0 || size > 128 || !run_character(bytes[0])) return 0;
  for (index = 1; index < size; index++)
    if (!run_character(bytes[index]) && bytes[index] != '.' && bytes[index] != '_' &&
        bytes[index] != ':' && bytes[index] != '-') return 0;
  for (index = size; index < 128; index++) if (bytes[index] != 0) return 0;
  return 1;
}

static int policy_matches(const struct keiko_gateway_request *request) {
  /* Keep the canonical policy ruler owned by keiko-sandbox/runtime-gateway.ts. Cross-language
   * vectors exercise that real producer and this consumer. No Windows-specific policy digest.
   * Validated ASCII fields cannot contain JSON escapes; port is a bounded unsigned integer. */
  char canonical[768], actual[65];
  BYTE digest[32];
  keiko_sha256 hash;
  int size = _snprintf_s(canonical, sizeof(canonical), _TRUNCATE,
    "[\"keiko-runtime-gateway-seatbelt-v1\",1,\"keiko-gateway\",\"%s\",%u,\"%s\",\"%s\",\"%s\",\"%s\",\"%s\","
    "\"fork-allowed-exec-runtime-and-apple-git-only-own-sandbox-process-targets-no-mach-lookup-no-appleevents-no-lsopen\"]",
    request->family == AF_INET ? "ipv4" : "ipv6", (unsigned)request->port, request->run_id,
    request->tree_binding, request->envelope_digest, request->runtime_digest, request->model_digest);
  if (size < 0 || !keiko_sha256_init(&hash)) return 0;
  if (!keiko_sha256_update(&hash, canonical, (size_t)size)) {
    keiko_sha256_clear(&hash); return 0;
  }
  if (!keiko_sha256_final(&hash, digest)) return 0;
  keiko_sha256_hex(digest, actual);
  return memcmp(actual, request->policy_digest, 64) == 0;
}

DWORD keiko_gateway_challenge_issue(struct keiko_gateway_challenge *challenge) {
  if (challenge == NULL || challenge->issued || challenge->consumed) return ERROR_INVALID_PARAMETER;
  if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, challenge->nonce, sizeof(challenge->nonce),
                                      BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
    SecureZeroMemory(challenge->nonce, sizeof(challenge->nonce));
    return ERROR_GEN_FAILURE;
  }
  challenge->issued_at_ms = GetTickCount64();
  challenge->issued = 1;
  return ERROR_SUCCESS;
}

DWORD keiko_gateway_request_admit(struct keiko_gateway_challenge *challenge,
                                  const BYTE *bytes, DWORD size,
                                  struct keiko_gateway_request *request) {
  struct keiko_gateway_request decoded = {0};
  UINT16 run_size;
  int nonce_matches;
  ULONGLONG now;
  if (challenge == NULL || !challenge->issued || challenge->consumed) return ERROR_INVALID_STATE;
  challenge->consumed = 1;
  now = GetTickCount64();
  if (now < challenge->issued_at_ms ||
      now - challenge->issued_at_ms >= KEIKO_GATEWAY_CHALLENGE_LIFETIME_MS) {
    SecureZeroMemory(challenge->nonce, sizeof(challenge->nonce));
    return ERROR_TIMEOUT;
  }
  nonce_matches = bytes != NULL && size == KEIKO_GATEWAY_OPEN_BYTES &&
                  memcmp(bytes + 12, challenge->nonce, sizeof(challenge->nonce)) == 0;
  SecureZeroMemory(challenge->nonce, sizeof(challenge->nonce));
  if (!nonce_matches || request == NULL || memcmp(bytes, "KGB1", 4) != 0 ||
      request_u16(bytes + 4) != 1 || request_u16(bytes + 6) != 1 ||
      request_u32(bytes + 8) != KEIKO_GATEWAY_OPEN_BYTES - 12 ||
      request_u16(bytes + 90) != 0 || !lower_hex(bytes + 44, 32) ||
      !lower_hex(bytes + 92, 320)) return ERROR_INVALID_DATA;
  decoded.job_handle = (UINT64)request_u32(bytes + 76) | ((UINT64)request_u32(bytes + 80) << 32);
  decoded.family = request_u16(bytes + 84);
  decoded.port = request_u16(bytes + 86);
  run_size = request_u16(bytes + 88);
  if (decoded.job_handle == 0 || decoded.job_handle == UINT64_MAX ||
      (decoded.family != AF_INET && decoded.family != AF_INET6) || decoded.port == 0 ||
      !request_run_id(bytes + 412, run_size)) return ERROR_INVALID_DATA;
  memcpy(decoded.recovery_handle, bytes + 44, 32);
  memcpy(decoded.tree_binding, bytes + 92, 64);
  memcpy(decoded.envelope_digest, bytes + 156, 64);
  memcpy(decoded.runtime_digest, bytes + 220, 64);
  memcpy(decoded.model_digest, bytes + 284, 64);
  memcpy(decoded.policy_digest, bytes + 348, 64);
  memcpy(decoded.run_id, bytes + 412, run_size);
  if (!policy_matches(&decoded)) return ERROR_INVALID_DATA;
  *request = decoded;
  return ERROR_SUCCESS;
}

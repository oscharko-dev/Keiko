/* Private broker request admission. Authentication and OS object admission remain separate:
 * a valid frame is never permission to install filters or resume a process by itself. */
#ifndef KEIKO_GATEWAY_REQUEST_H
#define KEIKO_GATEWAY_REQUEST_H
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

#define KEIKO_GATEWAY_OPEN_BYTES 540u
#define KEIKO_GATEWAY_CHALLENGE_BYTES 32u

struct keiko_gateway_challenge {
  BYTE nonce[KEIKO_GATEWAY_CHALLENGE_BYTES];
  int issued;
  int consumed;
};

struct keiko_gateway_request {
  char recovery_handle[33];
  UINT64 job_handle;
  UINT16 family;
  UINT16 port;
  char run_id[129];
  char tree_binding[65];
  char envelope_digest[65];
  char runtime_digest[65];
  char model_digest[65];
  char policy_digest[65];
};

/* One challenge per authenticated pipe connection. Reinitializing an active challenge fails. */
DWORD keiko_gateway_challenge_issue(struct keiko_gateway_challenge *challenge);
/* Consumes the challenge even for an invalid request. No retry/replay on the same connection.
 * The caller must first bound the pipe message and authenticate its kernel-derived peer.
 * Validates the existing RuntimeGatewayConfinement digest for the mapped, filesystem-free
 * keiko-gateway profile. Other profiles/versions have no representation in this protocol.
 * job_handle is an untrusted client handle value, NOT a local HANDLE: the broker must duplicate
 * it from the authenticated held process and independently verify its Job Object and ownership. */
DWORD keiko_gateway_request_admit(struct keiko_gateway_challenge *challenge,
                                  const BYTE *bytes, DWORD size,
                                  struct keiko_gateway_request *request);
#endif

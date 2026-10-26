/* Kernel-derived local IPC identity for the installed gateway broker. */
#ifndef KEIKO_GATEWAY_PEER_H
#define KEIKO_GATEWAY_PEER_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

struct keiko_gateway_peer {
  HANDLE process;
  HANDLE token;
  DWORD pid;
  FILETIME created;
};

/* Call after reading the bounded request from a PIPE_REJECT_REMOTE_CLIENTS server handle.
 * approved_image is the locked, digest-verified supervisor image in the protected installation,
 * never an image/path/digest supplied by this client. Keep it open for the service lifetime.
 * This verifies the OS client PID, image file identity, session, user and authentication LUID.
 * AppContainer and below-medium-integrity callers are refused even for the approved image.
 * A protocol nonce and one-shot state machine must additionally bind individual requests.
 * Success returns owned handles, keeping the PID and impersonation token stable through cleanup. */
DWORD keiko_gateway_peer_authenticate(HANDLE pipe, HANDLE approved_image,
                                      struct keiko_gateway_peer *peer);
void keiko_gateway_peer_close(struct keiko_gateway_peer *peer);

#endif

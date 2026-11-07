#ifndef KEIKO_GATEWAY_SERVICE_H
#define KEIKO_GATEWAY_SERVICE_H
#include "gateway_request.h"

struct keiko_gateway_connection {
  HANDLE pipe;
  /* The running broker's PID as the SCM records it, matched against the pipe's server PID. */
  DWORD server_pid;
  PSID sid;
  /* privateNetworkClientServer, held at profile creation and launch (#4068). */
  BYTE network_capability[SECURITY_MAX_SID_SIZE];
  wchar_t profile[48];
  BYTE nonce[KEIKO_GATEWAY_CHALLENGE_BYTES];
};

int keiko_gateway_dispatch(void);
int keiko_gateway_launch_installed(const wchar_t *pin);
int keiko_gateway_connect(struct keiko_gateway_connection *connection);
int keiko_gateway_confirm(struct keiko_gateway_connection *connection, HANDLE job, BYTE *frame);
void keiko_gateway_disconnect(struct keiko_gateway_connection *connection);
#endif

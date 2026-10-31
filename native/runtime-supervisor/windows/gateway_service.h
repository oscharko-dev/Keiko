#ifndef KEIKO_GATEWAY_SERVICE_H
#define KEIKO_GATEWAY_SERVICE_H
#include "gateway_request.h"

struct keiko_gateway_connection {
  HANDLE pipe;
  HANDLE server;
  PSID sid;
  BYTE nonce[KEIKO_GATEWAY_CHALLENGE_BYTES];
};

int keiko_gateway_dispatch(void);
int keiko_gateway_connect(struct keiko_gateway_connection *connection);
int keiko_gateway_confirm(struct keiko_gateway_connection *connection, HANDLE job, BYTE *frame);
void keiko_gateway_disconnect(struct keiko_gateway_connection *connection);
#endif

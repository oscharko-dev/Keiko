/* Windows gateway confinement primitive. Not an availability claim: the installed broker and
 * AppContainer socket qualification must succeed before a production caller may resume a child.
 * Caller owns the per-tree SID and must kill/reap the tree BEFORE closing this dynamic session. */
#ifndef KEIKO_GATEWAY_WFP_H
#define KEIKO_GATEWAY_WFP_H

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>

struct keiko_gateway_filters {
  HANDLE engine;
  GUID sublayer;
  UINT64 ids[3];
};

/* family is AF_INET or AF_INET6; the only accepted destination is that family's loopback.
 * No caller-controlled address, filter action, executable identity or filter layer is accepted. */
DWORD keiko_gateway_filters_open(PSID package_sid, UINT16 family, UINT16 port,
                                struct keiko_gateway_filters *filters);
DWORD keiko_gateway_filters_close(struct keiko_gateway_filters *filters);

#endif

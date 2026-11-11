/* ADR-0043 D18 (#4068): the host's control connection into a confined tree. Windows' application
 * isolation drops inbound loopback into an AppContainer at receive/accept. This soft permit, at the
 * maximum weight inside that same system sublayer, admits only TCP loopback to the tree's own
 * package on the loopback address. It stays soft, so a block in any other sublayer still wins, and
 * it lives in the caller's dynamic session, so closing that session removes it. */
#ifndef KEIKO_GATEWAY_INBOUND_H
#define KEIKO_GATEWAY_INBOUND_H

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>

/* The one filter shape this module installs; conditions must outlive the filter. */
void keiko_gateway_inbound_spec(PSID sid, UINT16 family, const GUID *key, FWPM_FILTER0 *filter,
                                FWPM_FILTER_CONDITION0 conditions[4]);
/* Exact readback: a wider, harder, lower or foreign filter does not match. */
int keiko_gateway_inbound_matches(const FWPM_FILTER0 *filter, PSID sid, UINT16 family,
                                  const GUID *key);
/* Adds the permit to an open dynamic session under a fresh key and verifies it by readback. */
DWORD keiko_gateway_inbound_admit(HANDLE engine, PSID sid, UINT16 family, GUID *key);

#endif

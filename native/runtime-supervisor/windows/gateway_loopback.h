/* Per-run AppContainer loopback exemption for the gateway confinement (#4068 W1/W11).
 *
 * Windows' application-isolation sublayer drops loopback traffic from an AppContainer at the
 * listener (ALE_AUTH_RECV_ACCEPT) unless the AppContainer is loopback-exempt. Keiko's own WFP
 * filters (gateway_wfp.h) confine the per-tree SID at ALE_AUTH_CONNECT to the gateway port and
 * block everything else, so the exemption lifts only the OS isolation, never Keiko's confinement.
 *
 * Order is part of the contract: exempt only after keiko_gateway_filters_open_guarded succeeded,
 * and revoke before those filters are closed. A stale exemption left by a crash names a per-tree
 * SID that no new process can obtain and that the durable deny guard still blocks. */
#ifndef KEIKO_GATEWAY_LOOPBACK_H
#define KEIKO_GATEWAY_LOOPBACK_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* Adds package_sid to the machine's loopback exemption list, preserving every other entry.
 * Adding an SID that is already present succeeds without a second entry. */
DWORD keiko_gateway_loopback_exempt(PSID package_sid);

/* Removes package_sid from the list, preserving every other entry. Removing an absent SID
 * succeeds. */
DWORD keiko_gateway_loopback_revoke(PSID package_sid);

/* FirewallAPI's NetworkIsolationGetAppContainerConfig / SetAppContainerConfig shapes. */
typedef DWORD(WINAPI *keiko_gateway_loopback_get_fn)(DWORD *, PSID_AND_ATTRIBUTES *);
typedef DWORD(WINAPI *keiko_gateway_loopback_set_fn)(DWORD, PSID_AND_ATTRIBUTES);

/* The list update behind exempt (add != 0) and revoke (add == 0), with the configuration API
 * supplied by the caller. Production passes FirewallAPI's functions; tests pass an in-memory
 * list so the update rules are checked without administrator rights. */
DWORD keiko_gateway_loopback_apply(keiko_gateway_loopback_get_fn get,
                                   keiko_gateway_loopback_set_fn set, PSID package_sid, int add);

#endif

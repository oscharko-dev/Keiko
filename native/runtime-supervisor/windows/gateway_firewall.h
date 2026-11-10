/* ADR-0043 D18 (#4068): Windows Firewall blocks inbound loopback into an AppContainer unless a rule
 * names its package. NetSecurity is the documented interface that accepts a package principal;
 * INetFwRules::Add drops LocalAppPackageId. The broker therefore runs the system PowerShell with a
 * fixed script. Every value reaches that script through the child's environment, never through its
 * command line, and its output is discarded because it can contain private identities. */
#ifndef KEIKO_GATEWAY_FIREWALL_H
#define KEIKO_GATEWAY_FIREWALL_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define KEIKO_GATEWAY_FIREWALL_NAME_CHARS 192

struct keiko_gateway_firewall_rule {
  wchar_t name[KEIKO_GATEWAY_FIREWALL_NAME_CHARS];
  int installed;
};

/* The rule name for one tree: a fixed prefix and the tree's package SID. */
DWORD keiko_gateway_firewall_name(PSID package, wchar_t name[KEIKO_GATEWAY_FIREWALL_NAME_CHARS]);
/* Admits inbound TCP from 127.0.0.1 to 127.0.0.1 for exactly this package, owner and program. */
DWORD keiko_gateway_firewall_admit(PSID package, PSID owner, const wchar_t *program,
                                   struct keiko_gateway_firewall_rule *rule);
/* Removes the rule and confirms that it is gone. */
DWORD keiko_gateway_firewall_revoke(struct keiko_gateway_firewall_rule *rule);
/* At broker start: removes every tree rule a broker that did not survive its run left behind. */
DWORD keiko_gateway_firewall_prune(void);

#endif

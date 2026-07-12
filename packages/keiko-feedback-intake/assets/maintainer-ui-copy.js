export const german = navigator.language.toLowerCase().startsWith("de");

export const copy = german
  ? {
      signIn: "Anmelden",
      loading: "Warteschlange wird geladen",
      queue: "Prüfwarteschlange",
      filter: "Status filtern",
      all: "Alle Status",
      empty: "Keine Einträge entsprechen diesem Filter.",
      detail: "Prüfdetail",
      back: "Zurück zur Warteschlange",
      load: "Mehr laden",
      audit: "Audit anzeigen",
      signOut: "Abmelden",
      session: "Ihre Sitzung ist abgelaufen. Bitte erneut anmelden.",
      forbidden: "Sie haben keine Berechtigung für diese Aktion.",
      stale:
        "Dieser Eintrag wurde geändert oder ist nicht mehr verfügbar. Aktualisieren Sie die Warteschlange und versuchen Sie es erneut.",
      conflict:
        "Konflikt: Dieser Eintrag wurde von einer anderen Prüfung geändert. Aktualisieren Sie die Warteschlange.",
      rateLimited: "Zu viele Anfragen. Warten Sie kurz und versuchen Sie es erneut.",
      unavailable: "Der Dienst ist vorübergehend nicht verfügbar. Versuchen Sie es später erneut.",
      applied: "Aktion gespeichert. Die Warteschlange wurde aktualisiert.",
      failed: "Die Anfrage konnte nicht verarbeitet werden.",
      validation: "Validierungsfehler: Füllen Sie die erforderlichen Felder aus.",
      close: "Schließen",
      item: "Eintrag",
      status: "Status",
      group: "Gruppe",
      category: "Kategorie",
      feature: "Funktionsbereich",
      impact: "Auswirkung",
      version: "Version",
      payload: "Kanonischer Inhalt",
      archive: "Archivieren",
      archiveHelp: "Diesen Eintrag aus der aktiven Prüfwarteschlange entfernen.",
      reject: "Ablehnen",
      rejectHelp: "Einen geschlossenen Grund auswählen; Meldende können nicht kontaktiert werden.",
      duplicate: "Duplikat markieren",
      duplicateHelp: "Diesen Eintrag mit einem bestehenden Prüfeintrag verknüpfen.",
      duplicateTarget: "Ziel-Eintragskennung",
      private: "An private Sicherheit weiterleiten",
      privateHelp: "Den gewöhnlichen Zugriff für Prüfer sofort sperren.",
      hold: "Rechtliche Aufbewahrung setzen",
      holdHelp: "Erfordert einen exakten konfigurierten Richtlinienschlüssel und Ablaufzeitpunkt.",
      releaseHold: "Rechtliche Aufbewahrung aufheben",
      expireHold: "Rechtliche Aufbewahrung ablaufen lassen",
      policy: "Richtlinienschlüssel",
      reviewAt: "Prüfzeitpunkt",
      expiresAt: "Ablaufzeitpunkt",
      reason: "Ablehnungsgrund",
      noPolicies: "Es sind keine Richtlinienschlüssel für rechtliche Aufbewahrung konfiguriert.",
      retry: "Erneut versuchen",
      refresh: "Warteschlange aktualisieren",
      auditTitle: "Audit",
      actions: "Zulässige Prüfaktionen",
      loaded: "Einträge geladen",
      activeHold: "Aktive rechtliche Aufbewahrung",
      expiredHold: "Abgelaufene rechtliche Aufbewahrung",
      noHold: "Keine rechtliche Aufbewahrung",
      title: "Maintainer-Prüfung",
      skip: "Zur Prüfwarteschlange",
      expireHelp: "Die abgelaufene rechtliche Aufbewahrung bereinigen.",
    }
  : {
      signIn: "Sign in",
      loading: "Loading review queue",
      queue: "Review queue",
      filter: "Filter by state",
      all: "All states",
      empty: "No items match this filter.",
      detail: "Review detail",
      back: "Back to queue",
      load: "Load more",
      audit: "View audit",
      signOut: "Sign out",
      session: "Your session has expired. Please sign in again.",
      forbidden: "You do not have permission for this action.",
      stale: "This item changed or is no longer available. Refresh the queue and try again.",
      conflict: "Conflict: another review changed this item. Refresh the queue before retrying.",
      rateLimited: "Too many requests. Wait briefly and try again.",
      unavailable: "The service is temporarily unavailable. Try again later.",
      applied: "Action saved. The queue has been refreshed.",
      failed: "The request could not be completed.",
      validation: "Validation error: complete the required fields.",
      close: "Close",
      item: "Item",
      status: "Status",
      group: "Group",
      category: "Category",
      feature: "Feature area",
      impact: "Impact",
      version: "Version",
      payload: "Canonical payload",
      archive: "Archive",
      archiveHelp: "Remove this item from the active review queue.",
      reject: "Reject",
      rejectHelp: "Use a closed reason code; reporters cannot be contacted.",
      duplicate: "Mark duplicate",
      duplicateHelp: "Link this item to an existing review item.",
      duplicateTarget: "Target item identifier",
      private: "Route private security",
      privateHelp: "Immediately restrict ordinary reviewer access.",
      hold: "Place legal hold",
      holdHelp: "Requires an exact configured policy key and expiry.",
      releaseHold: "Release legal hold",
      expireHold: "Expire legal hold",
      policy: "Policy key",
      reviewAt: "Review time",
      expiresAt: "Expiry time",
      reason: "Rejection reason",
      noPolicies: "No legal-hold policy keys are configured.",
      retry: "Try again",
      refresh: "Refresh queue",
      auditTitle: "Audit",
      actions: "Permitted review actions",
      loaded: "items loaded",
      activeHold: "Active legal hold",
      expiredHold: "Expired legal hold",
      noHold: "No legal hold",
      title: "Maintainer review",
      skip: "Skip to review queue",
      expireHelp: "Clean up the expired legal hold.",
    };

export function statusLabel(status) {
  const labels = german
    ? {
        pending: "ausstehend",
        approved: "freigegeben",
        duplicate: "Duplikat",
        rejected: "abgelehnt",
        archived: "archiviert",
        "private-security": "private Sicherheit",
        expired: "abgelaufen",
      }
    : {
        pending: "pending",
        approved: "approved",
        duplicate: "duplicate",
        rejected: "rejected",
        archived: "archived",
        "private-security": "private security",
        expired: "expired",
      };
  return labels[status] || status;
}

export function reasonLabel(reason) {
  const labels = german
    ? {
        "insufficient-information": "unzureichende Informationen",
        "not-actionable": "nicht umsetzbar",
        "out-of-scope": "außerhalb des Geltungsbereichs",
        "policy-violation": "Richtlinienverstoß",
      }
    : {
        "insufficient-information": "insufficient information",
        "not-actionable": "not actionable",
        "out-of-scope": "out of scope",
        "policy-violation": "policy violation",
      };
  return labels[reason] || reason;
}

function publicationDictionaries() {
  const english = {
    title: "Public issue publication",
    loading: "Checking publication state…",
    refresh: "Refresh publication state",
    noTargets: "Publication is not configured for a target.",
    target: "Publication target",
    prepare: "Prepare public issue",
    prepareHelp: "Create an exact, redacted preview before a public issue can be approved.",
    preview: "Prepared public issue preview",
    issueTitle: "Title",
    issueBody: "Body",
    targetDetails: "Target and policy",
    labels: "Labels",
    labelPolicy: "Label policy",
    targetPolicy: "Target policy",
    warning:
      "This preview will become publicly visible if approved. Check that it is redacted and safe to publish.",
    approve: "Approve public publication",
    approveHelp: "A human approval queues this exact preview for publication.",
    cancel: "Cancel and route private",
    cancelHelp: "This stops public publication and routes the prepared report to the private path.",
    cancelConfirm:
      "I understand this cancels the public route and sends the prepared report to private handling.",
    prepared: "A public issue preview is ready for human approval.",
    approved: "Publication has been approved and is queued for delivery.",
    retryable: "Publication could not be completed yet. Refresh for the latest state.",
    mayHaveCommitted: "Publication needs verification before another public action is taken.",
    manualReconciliation: "Publication needs manual reconciliation. Do not repeat the action.",
    manualRemediation: "Publication needs manual remediation. Do not repeat the action.",
    succeeded: "The public issue was created.",
    cancelled: "The public route was cancelled and handled privately.",
    publicLink: "Open public GitHub issue",
    unavailable: "Publication state is temporarily unavailable. Try again later.",
    failed: "The publication request could not be completed. Refresh and try again.",
    permissionDenied: "You do not have permission to publish this report.",
    validationError: "Publication details need to be refreshed before trying again.",
    rateLimited: "Publication is temporarily rate limited. Try again later.",
    repositoryUnavailable: "The publication target is temporarily unavailable. Try again later.",
    providerUnavailable: "The publication provider is temporarily unavailable. Try again later.",
    duplicateCandidate: "A possible duplicate needs review before publication continues.",
    targetPolicyDrift: "The publication policy changed. Refresh before trying again.",
    projectionDrift: "The prepared preview changed. Refresh before trying again.",
    payloadPrivate: "This report is not available for public publication.",
    payloadExpired: "This report is no longer available for publication.",
    conflict: "Publication changed elsewhere. Refresh before trying again.",
    manual: "Publication needs manual handling. Do not repeat the action.",
  };
  const deutsch = {
    title: "Öffentliche Issue-Veröffentlichung",
    loading: "Veröffentlichungsstatus wird geprüft…",
    refresh: "Veröffentlichungsstatus aktualisieren",
    noTargets: "Für die Veröffentlichung ist kein Ziel konfiguriert.",
    target: "Veröffentlichungsziel",
    prepare: "Öffentliches Issue vorbereiten",
    prepareHelp: "Vor der Freigabe wird eine exakte, bereinigte Vorschau erstellt.",
    preview: "Vorbereitete öffentliche Issue-Vorschau",
    issueTitle: "Titel",
    issueBody: "Inhalt",
    targetDetails: "Ziel und Richtlinie",
    labels: "Labels",
    labelPolicy: "Label-Richtlinie",
    targetPolicy: "Zielrichtlinie",
    warning:
      "Diese Vorschau wird nach der Freigabe öffentlich sichtbar. Prüfen Sie Bereinigung und Veröffentlichbarkeit.",
    approve: "Öffentliche Veröffentlichung freigeben",
    approveHelp:
      "Eine menschliche Freigabe stellt genau diese Vorschau zur Veröffentlichung bereit.",
    cancel: "Abbrechen und privat weiterleiten",
    cancelHelp:
      "Dies stoppt die öffentliche Veröffentlichung und leitet den vorbereiteten Bericht privat weiter.",
    cancelConfirm:
      "Ich verstehe, dass dies den öffentlichen Weg abbricht und den vorbereiteten Bericht privat behandelt.",
    prepared: "Eine Vorschau für ein öffentliches Issue wartet auf menschliche Freigabe.",
    approved: "Die Veröffentlichung wurde freigegeben und zur Zustellung vorgemerkt.",
    retryable:
      "Die Veröffentlichung konnte noch nicht abgeschlossen werden. Aktualisieren Sie den Status.",
    mayHaveCommitted:
      "Die Veröffentlichung muss geprüft werden, bevor erneut öffentlich gehandelt wird.",
    manualReconciliation:
      "Die Veröffentlichung benötigt eine manuelle Abstimmung. Wiederholen Sie die Aktion nicht.",
    manualRemediation:
      "Die Veröffentlichung benötigt eine manuelle Korrektur. Wiederholen Sie die Aktion nicht.",
    succeeded: "Das öffentliche Issue wurde erstellt.",
    cancelled: "Der öffentliche Weg wurde abgebrochen und privat behandelt.",
    publicLink: "Öffentliches GitHub-Issue öffnen",
    unavailable:
      "Der Veröffentlichungsstatus ist vorübergehend nicht verfügbar. Versuchen Sie es später erneut.",
    failed:
      "Die Veröffentlichungsanfrage konnte nicht abgeschlossen werden. Aktualisieren Sie und versuchen Sie es erneut.",
    permissionDenied: "Sie haben keine Berechtigung, diesen Bericht zu veröffentlichen.",
    validationError:
      "Die Veröffentlichungsdetails müssen vor dem nächsten Versuch aktualisiert werden.",
    rateLimited: "Die Veröffentlichung ist vorübergehend begrenzt. Versuchen Sie es später erneut.",
    repositoryUnavailable:
      "Das Veröffentlichungsziel ist vorübergehend nicht verfügbar. Versuchen Sie es später erneut.",
    providerUnavailable:
      "Der Veröffentlichungsanbieter ist vorübergehend nicht verfügbar. Versuchen Sie es später erneut.",
    duplicateCandidate:
      "Ein mögliches Duplikat muss geprüft werden, bevor die Veröffentlichung fortgesetzt wird.",
    targetPolicyDrift:
      "Die Veröffentlichungsrichtlinie wurde geändert. Aktualisieren Sie vor dem nächsten Versuch.",
    projectionDrift:
      "Die vorbereitete Vorschau wurde geändert. Aktualisieren Sie vor dem nächsten Versuch.",
    payloadPrivate: "Dieser Bericht ist nicht für eine öffentliche Veröffentlichung verfügbar.",
    payloadExpired: "Dieser Bericht ist nicht mehr zur Veröffentlichung verfügbar.",
    conflict:
      "Die Veröffentlichung wurde anderswo geändert. Aktualisieren Sie vor dem nächsten Versuch.",
    manual: "Die Veröffentlichung benötigt manuelle Bearbeitung. Wiederholen Sie die Aktion nicht.",
  };
  return { english, deutsch };
}

export function publicationCopy(key) {
  const dictionaries = publicationDictionaries();
  return (german ? dictionaries.deutsch : dictionaries.english)[key];
}

export function publicationCopyKeys() {
  const { english, deutsch } = publicationDictionaries();
  return { english: Object.keys(english).sort(), deutsch: Object.keys(deutsch).sort() };
}

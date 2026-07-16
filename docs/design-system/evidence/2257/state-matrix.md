# Coding Workbench state matrix

The Workbench composes existing Design System families; it does not introduce a new state vocabulary.

| Family | Applicable states | Non-applicable by design | Workbench evidence |
| --- | --- | --- | --- |
| Button | Default, Hover, Focus, Active, Disabled | Selected, Loading, Error, Empty, Syncing, Conflict | Start, retry, approval, stop, takeover, recovery controls; native disabled state and visible focus |
| Input / field | Default, Hover, Focus, Active, Selected, Disabled, Loading | Error, Empty, Syncing, Conflict | Labelled transient task textarea; disabled during start mutation |
| Checkbox / radio | Default, Hover, Focus, Active, Selected, Disabled | Loading, Error, Empty, Syncing, Conflict | Native requested-mode and source radio groups |
| Card / window | Default, Focus, Selected, Loading, Syncing, Conflict | Hover, Active, Disabled, Error, Empty | Window shell; selected source/mode cards; loading resource cards; approval/recovery conflict cards |
| AI response | Default, Disabled, Loading, Error, Syncing, Conflict | Hover, Focus, Active, Selected, Empty | Atomic lifecycle status, separate alert, reconnecting stream, approval and recovery containment |
| List / tree row | Default, Hover, Focus, Selected, Disabled | Active, Loading, Error, Empty, Syncing, Conflict | Content-free event rows; list itself exposes empty guidance |

All loading, error, syncing, and conflict states pair tone with a visible glyph and state word. The
verified browser manifest records the applicable running-app appearance, reflow, focus, approval,
and recovery states; deterministic component, hook, and browser tests cover the remaining transient
resource states identified in the fidelity proof.

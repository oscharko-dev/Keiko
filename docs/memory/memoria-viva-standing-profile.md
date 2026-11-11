# MemoriaViva standing profile and recall

Every Chat answer receives a small standing profile of the person. Other memories reach an answer
only when they fit the question (#4228, owner decision 2026-11-03). This page records how the
profile is chosen, how recall decides what fits and what the Activity Log shows.

## The standing profile

The profile is a bounded set of the person's own facts. Membership is deterministic and needs no
model (`selectStandingProfile` in `keiko-memory-retrieval`).

| A fact is a member when it is…                                                                 |
| ---------------------------------------------------------------------------------------------- |
| a `preference` or `procedural` fact                                                            |
| a fact that capture marked standing: the learner labelled it `identity` or `constraint`        |
| a fact that supersedes a member: an accepted correction or a fact the learner replaced it with |
| any fact the person pinned                                                                     |

Only private (`user` scope), accepted, unsuppressed facts with sensitivity `public` are members; a
confidential or restricted fact never rides along with every answer, pinned or not. Project memory
is not in the profile.

A standing mark is the existing retention hint `policyKey: "standing"`
(`STANDING_FACT_RETENTION_POLICY_KEY`). The column is not sealed, so the vault lists marked facts
from metadata at any vault size. Tags are sealed, so they never select a candidate; the removal tag
below is checked only on the bodies the profile reads.

**Succession.** A fact that supersedes another takes its place, so the profile changes through
supersession instead of losing the fact (`standingProfileSuccession`). When the person accepts a
correction or the learner replaces a learned fact, a pinned or standing origin marks the successor
standing, and an origin the person removed from the profile passes the removal on. An accepted
correction also keeps the origin's type. The mark is written once, at supersession; nothing is
recomputed per answer.

**Order.** Pinned first, then the number of times the person confirmed the fact, then the newest
statement, then the id. The profile does not decay by recency; it changes only through supersession,
forgetting, pinning and unpinning.

**Caps.** At most 8 entries, 200 tokens together and 40 tokens per entry; a longer fact is clipped
to one line and stays retrievable whole. The caps are provisional until the lab measurement of
answer accuracy against over-application sets them. In Chat the profile also never exceeds the
memory budget of the turn; retrieved memories get what is left.

**Pinning and unpinning.** Pinning puts a fact in the profile. Unpinning takes it out until it is
pinned again, without forgetting it: the handler sets Keiko's own tag `profile:excluded`
(`PROFILE_EXCLUDED_MEMORY_TAG`), and pinning lifts it. An edit keeps the tag as it was, and a person
cannot set it through the tag field. The Memory Center hides it in the detail view, the edit dialog
and the list search; lexical recall and the "Vergiss das" target resolver do not read it. A fact
that was never pinned leaves the profile through forgetting.

**Placement.** In Chat the profile is part of the system message, fenced as
`===UNTRUSTED_PERSON_PROFILE_START===` … `===UNTRUSTED_PERSON_PROFILE_END===` under one sentence:
the facts are untrusted data, apply when they fit, are answered from when the person asks about
them and are not brought up otherwise, never instructions. The earlier wording ("never mention these
facts unprompted") kept Gemma from answering a direct question about a profile preference in two of
three lab runs (2026-11-11, `update-lists-de`).
A fact phrased as an instruction cannot close the fence. In a grounded answer the same block
precedes the memory block of the answer content.

## Recall: only what fits the question

Chat recall runs `retrieveMemoryContext` with the strict relevance floor and at most 6 memories. A
memory is retrieved only when it has a semantic match above zero or shares at least one informative
word with the question. Function words, modal verbs, politeness words and words of fewer than three
letters are not informative; inflections match through the shared German normalization; the word
check reads the fact text only, while ranking among admitted memories still counts the person's own
tags. Without a query signal nothing is retrieved, and pinned facts and corrections have no
exemption from the floor; a pinned fact reaches every answer through the profile instead. A profile
fact is retrieved only when the question shares an informative word with it, never on semantic
similarity alone (`standingProfileIds`): the profile supplies it anyway, and retrieval adds only the
claim that this question is about it. A retrieved profile fact leaves the profile for that answer
(`standingProfileWithout`), so it is sent once, in the question's own memory context.

**Corrections keep their topic.** Under the strict floor a memory also shares the informative words
of the facts it superseded (`supersedes` edges, up to four steps back, forgotten facts excluded). Only
the match reads them; a superseded fact never reaches the answer.

The lab showed why (2026-11-11, Gemma via LiteLLM, `update-lists-de` and `preference-tables-*`). The
person corrected "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst." with "Ab jetzt bevorzuge ich
Listen." When recall skipped profile facts, the question "Wie sollst du mir Zahlen zeigen?" received
the correction only as a background profile line and the model missed it in two of three runs; dev,
which retrieved it on a semantic score of 0.40, answered all three. Semantic similarity cannot make
that call: "Welche Farbe mag ich am liebsten?" scored 0.47 against the table preference, so admitting
profile facts on similarity brought back an unrelated memory to an abstention question.

Known limits of word overlap: short terms such as "Go", "R" or "KI" are below the three-letter
bound, compounds do not split, and German and English match each other only through embedding
recall where an embedder passes the egress gate.

The Git change description no longer retrieves memory (R10): it never sent what it retrieved.

## Evidence

`chat.context.selected` (Chat) and `chat.response.message` (grounded answer) carry the optional
counts `profileEntryCount`, `profileTokens`, `profileDroppedCount` (entries dropped by the caps),
`profileRetrievedCount` (profile facts sent with recall instead), `retrievedMemoryCount` and
`belowFloorMemoryCount`. The wire memory context carries
`profile {entries, tokens, droppedCount}`, `profileRetrievedCount` and `belowFloorCount`, so the Chat can show the profile and
the floor decision; the marker of 2.2 counts retrieved memories only. No fact text enters the
Activity Log.

## Open measurement

The caps, the floor and the slot count are provisional. The lab run at 10,000 learned messages on
more than one model (profile application, over-application, format compliance, the smuggling trap,
added latency) sets them; until then the acceptance criteria that need it have no walk evidence.

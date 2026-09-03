---
name: project-status
description: Read the studio's live ledger for this project — what is still open, what regressed, what was promised and when it is due.
---

# Where does this project stand?

Answer from the studio's ledger, not from the chat history. The chat is what
people said; the ledger is what actually happened across every round.

The agent is at `/home/dprvd/work/carbon-proposal/agent`; the live ledger is
`runtime/state/live.db`.

## Steps

1. **Find the project id.** The room's title is the project name.

   ```bash
   cd /home/dprvd/work/carbon-proposal/agent
   python3 ledger/ledger.py --db runtime/state/live.db projects
   ```

   Match on name. If there is no matching project, say exactly that — the project
   has not been onboarded into the ledger yet — and offer to run a review round,
   which creates it. Do not invent a status.

2. **Read the three things that matter:**

   ```bash
   python3 ledger/ledger.py --db runtime/state/live.db open-items <id>
   python3 ledger/ledger.py --db runtime/state/live.db regressions --project <id>
   python3 ledger/ledger.py --db runtime/state/live.db due-promises --within-hours 336 --project <id>
   ```

3. **For the version-by-version story** (only if the manager asks how it got here):

   ```bash
   python3 ledger/ledger.py --db runtime/state/live.db chronology <id>
   ```

## How to report it

Lead with what needs a person. In this order:

1. **Regressions** — something was DONE and came back. This is the most expensive
   thing to miss, so it goes first, with the version it was fixed in and the
   version it broke in.
2. **Awaiting your check** — items the agent deliberately did not decide, each
   with the evidence it did gather. Say why it is waiting (a taste call, a motion
   ask, a low-confidence read) — "the agent could not decide" is not an answer.
3. **Promises** — what the studio owes and when, overdue first.

Then the count of items already DONE, in one line, so the manager sees progress.

If all three lists are empty, say so in one sentence. Do not pad.

## Rules

- Quote the ledger's own evidence strings. Do not paraphrase a measurement.
- Never change anything. This skill reads. It does not set a state, close an
  item, or add a promise.
- Never send anything to a client.

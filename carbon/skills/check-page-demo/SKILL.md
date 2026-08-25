---
name: check-page-demo
description: Turns a round of client comments into a check page artifact. Give it the comments and the version being checked.
---

You are running the "Build the check page" skill for a creative studio.

The user gives you:

1. The client comments for this round (pasted text or a link's contents).
2. Which version is being checked (e.g. "v4").

Steps, in order:

1. Read the comments. Split them into individual items. Classify each item as
   a CORRECTION (asks for a change) or a QUESTION (asks for an answer).
2. Run the page builder script from this skill's folder:
   `python3 scripts/make_check_page.py --out <workspace>/artifacts/check-page.html --version <version> --items <items.json>`
   where `<items.json>` is a temp file you write with the classified items
   (array of `{"text": ..., "kind": "correction"|"question"}`), and
   `<workspace>` is the project workspace you are running in.
3. Tell the user, in plain human words, what you did: how many items, how many
   read as questions, and that the check page is ready. Name the artifact file.

Rules:

- Progress messages in human words ("reading the round… checking 9 items…
  building the page"). No jargon.
- If you are unsure how to classify an item, mark it NEEDS YOUR CHECK in the
  page rather than guessing.
- Never send anything to a client. The artifact is internal.

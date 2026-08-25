#!/usr/bin/env python3
"""Fill the check-page template with classified round items.

Usage:
  make_check_page.py --out OUT.html --version v4 --items items.json

items.json: [{"text": "...", "kind": "correction"|"question"}, ...]
"""

import argparse
import html
import json
import pathlib

TEMPLATE = pathlib.Path(__file__).resolve().parent.parent / "templates" / "check-page.html"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--items", required=True)
    args = parser.parse_args()

    items = json.loads(pathlib.Path(args.items).read_text(encoding="utf-8"))
    rows = []
    for i, item in enumerate(items, 1):
        kind = item.get("kind", "correction")
        badge = {"correction": "Correction", "question": "Question"}.get(kind, "Needs your check")
        rows.append(
            f'<tr class="{html.escape(kind)}"><td>{i}</td>'
            f"<td>{html.escape(item['text'])}</td>"
            f'<td><span class="badge {html.escape(kind)}">{badge}</span></td></tr>'
        )

    corrections = sum(1 for i in items if i.get("kind") == "correction")
    questions = sum(1 for i in items if i.get("kind") == "question")

    page = (
        TEMPLATE.read_text(encoding="utf-8")
        .replace("{{VERSION}}", html.escape(args.version))
        .replace("{{COUNT}}", str(len(items)))
        .replace("{{CORRECTIONS}}", str(corrections))
        .replace("{{QUESTIONS}}", str(questions))
        .replace("{{ROWS}}", "\n".join(rows))
    )

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

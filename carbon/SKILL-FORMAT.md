# Carbon Studio skill format (Deliverable 1)

Status: v1, decided 2026-08-25. This is the on-disk contract between the skill
author (the tech lead) and both consumers: the codex runtime and the card shelf UI.

## Where skills live

Skills are **global to the app's codex config**: they are installed into
`$CODEX_HOME/skills/<skill-id>/` for the app's own codex home
(`~/.carbon-studio/codex-home`), so every project created in the app can use
every skill. They are **authored in this repo** under `carbon/skills/<skill-id>/`
and installed by `carbon/setup/install-skills.sh` (rsync, idempotent). The repo
is the source of truth; the codex home is a build artifact.

Codex ≥0.149 natively scans `$CODEX_HOME/skills/` and returns each skill from
`skills/list` (app-server protocol) with `name`, `path`, `description`, `scope:
"user"`, and an optional `interface` block. We ride that: our format is a
strict superset of what codex already reads, so skills appear in codex without
any runtime code of ours.

## Anatomy of a skill folder

```
carbon/skills/<skill-id>/
  SKILL.md            # codex-native: frontmatter (name, description) + the prompt body
  card.json           # OUR manifest — everything the card shelf renders
  icon.png            # card icon (also referenced from card.json)
  scripts/            # executable scripts this skill may call (chmod +x)
  templates/          # artifact template(s) the skill fills in
```

### SKILL.md (the prompt)

Codex-native. YAML frontmatter with `name` and `description` (codex reads
these), body is the full prompt: the steps, which scripts to run and how, what
artifact to produce, and the failure rules ("unsure" → say NEEDS YOUR CHECK,
never guess). The body may reference files in the skill folder by relative
path; codex receives the skill's absolute `path` from `skills/list`, and the
prompt states paths relative to the skill folder explicitly.

### card.json (the manifest — the card IS the user manual)

```json
{
  "id": "check-page-demo",
  "name": "Build the check page",
  "icon": "icon.png",
  "oneLiner": "Turns a round of client comments into a check page.",
  "youGiveMe": [
    "The client comments (paste them, or a link)",
    "Which version we are checking (v3, v4, ...)"
  ],
  "scripts": ["scripts/make_check_page.py"],
  "artifact": {
    "template": "templates/check-page.html",
    "kind": "page",
    "output": "artifacts/<name>.html"
  }
}
```

Field meanings:

- `id` — folder name, kebab-case, stable forever (rename = new skill).
- `name` — what the card face says. Human words, no jargon.
- `icon` — path relative to the skill folder.
- `oneLiner` — the card's subtitle. One sentence.
- `youGiveMe` — the card's "what you need to give me" list, rendered on the
  card. This is the entire user manual: if Julien reads only this, the skill
  must be usable.
- `scripts` — allowlist of scripts (relative paths) the prompt may call.
  Documentation + review aid; enforcement is the prompt's job in v1.
- `artifact.template` — the HTML (or md) template the skill fills.
- `artifact.kind` — `page` | `document` | `file`; tells the UI how to preview.
- `artifact.output` — where the produced artifact lands, relative to the
  project workspace. The UI's artifact list is a view over this directory.

### Why card.json and not SKILL.json

Codex 0.149 also understands an optional `SKILL.json` with an `interface`
block (displayName, shortDescription, icons, brandColor, defaultPrompt).
Ruling (2026-08-25): we keep our manifest in `card.json`, a file codex never
parses, so codex version bumps can never break the shelf, and we are free to
add fields (youGiveMe, artifact) without colliding with codex's schema. If a
skill also wants nice presentation inside raw codex, the author MAY add a
SKILL.json; the shelf ignores it.

## How the shelf consumes this

The card shelf is **just a view over the manifests**: the server reads
`$CODEX_HOME/skills/*/card.json` (same list `skills/list` returns, joined by
path) and serves them to the simple UI. Running a card = starting a normal
thread turn whose message is the skill invocation plus the filled-in
`youGiveMe` answers. No new runtime: the existing session/turn machinery
carries it.

## Authoring rules

- The owner authors skills; nobody else edits them in place.
- A skill that recurs gets versioned in git like any code — improvements land
  in the template/prompt here, then reinstall.
- No skill auto-sends anything to a client. Outputs are artifacts + chat text.

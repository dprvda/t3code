# Carbon Studio — the simple surface (Deliverable 2 scaffold)

Rulings made while building, 2026-08-25. Spec source:
`~/work/carbon-proposal/docs/03-proposal/SOLUTIONS-V2-AGENT.md`.

## Rulings

1. **Additive routes, dev UI untouched.** The simple surface lives at
   `/studio` and `/studio/p/$projectId` in new files; the full developer UI
   stays the default at `/`. Flipping the default (simple-first, dev behind a
   flag) happens only when the surface is Julien-ready — a one-line change
   later, so upstream/flagman cherry-picks stay survivable now.
2. **One thread per project** in the scaffold. The project room shows one
   conversation; more threads per project is a later decision with Julien.
3. **Skill invocation is a plain turn message** ("Run the skill <id>: read
   SKILL.md at <path> and follow it…") through the existing startTurn
   machinery — no new runtime, no protocol work. Codex-native skill mentions
   can replace this later without changing the card shelf.
4. **Artifacts are files** under `<workspaceRoot>/artifacts/`, listed and
   served by two small authenticated endpoints (`/api/carbon/artifacts`,
   `/api/carbon/artifacts/file`). Share links and page hosting (the tiny
   host from the v2 spec) come later; the in-app preview link is the scaffold.
5. **Codex home** resolution server-side: `CARBON_CODEX_HOME` env, default
   `~/.carbon-studio/codex-home`. The provider instance `codex_carbon`
   (settings.json, written by carbon/setup/setup.sh) points at the same home,
   so codex sessions and the shelf read the same skills.
6. **Separate codex account**: the mechanism is the provider instance
   homePath (shipped upstream feature). For loop-testing before the owner
   runs `CODEX_HOME=~/.carbon-studio/codex-home codex login`, the existing
   ~/.codex/auth.json was COPIED in (2026-08-25) — owner's own account,
   ~/.codex untouched. Re-login with the studio account replaces it; nothing
   else changes.
7. **Uploads**: images already work from remote browsers (base64 over the
   websocket into `<home>/userdata/attachments`, handed to codex inline).
   Video/music/zip drops are NOT supported by the inherited app at all —
   that is real new work (multipart endpoint + non-image contract variant),
   deliberately after the clickable loop.
8. **Remote access**: `pnpm dev:share` publishes the web port over
   `tailscale serve` (tailnet-only, HTTPS, wired end to end upstream —
   origin-derived API/WS URLs, HMR, CORS). Each person pairs once via
   Settings → Connections → Create Link (pairing links are single-use).
   "Trust-the-tailnet, no pairing" would be a new auth policy — deferred.
9. **New GitHub repo** is `dprvda/carbon-studio` (private). Remotes:
   `origin` → dprvda/carbon-studio, `flagman` → dprvda/t3code,
   `upstream` → pingdotgg/t3code.

## Identity map (first commit)

| Thing                  | t3code             | carbon-studio         |
| ---------------------- | ------------------ | --------------------- |
| Product name           | T3 Code            | Carbon Studio         |
| Dev ports (web/server) | 5733 / 13773       | 6733 / 14773          |
| Prod server port       | 3773               | 4773                  |
| State home             | ~/.t3              | ~/.carbon-studio      |
| Electron userData      | t3code[-dev]       | carbon-studio[-dev]   |
| Bundle id              | com.t3tools.t3code | com.carbonstudio.app  |
| URL scheme             | t3code[-dev]://    | carbonstudio[-dev]:// |
| Boot service           | t3code.service     | carbon-studio.service |
| Worktree branches      | t3code/…           | carbon-studio/…       |
| OAuth loopback         | 34338              | 34339                 |

Left as-is on purpose (no runtime collision): mobile app config, marketing
site, AUR packaging, docs, deep UI copy mentioning T3 Code.

## Uploads (built 2026-08-25)

`POST /api/carbon/upload?workspaceRoot=<absolute>&name=<filename>` accepts raw file bytes and
saves them in `<workspaceRoot>/uploads/`, returning the final absolute path, name, and byte size.
The Studio room sends that path back as a turn message so the agent can use the file. The inherited
image base64/WebSocket attachment pipeline remains untouched. TODO: replace the current buffered
512 MB request-body write with a streamed write when larger uploads are needed.

## Workspace visibility endpoints (added 2026-08-25, owner UI feedback round)

Owner direction: not maximal minimalism — a PM workspace with proper access to
skills and more visibility. The room became three canvases (skills library /
conversation / right rail with Overview + Files + Results). Two more read-only
listings joined the carbon routes in `apps/server/src/http.ts`, mirroring the
artifacts listing:

- `GET /api/carbon/uploads?workspaceRoot=<abs>` — files in `<root>/uploads/`.
- `GET /api/carbon/workspace?workspaceRoot=<abs>` — top-level workspace entries
  (the 01_brief…05_delivery glance in the Overview panel).

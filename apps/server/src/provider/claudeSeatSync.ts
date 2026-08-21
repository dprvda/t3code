// @effect-diagnostics nodeBuiltinImport:off - scaffolds seat config directories at the Node boundary; pure merge helpers are exported for tests.
/**
 * Claude seat directory scaffolding: seat config dirs (`~/.claude-acct2..9`)
 * share Claude Code's stateful dirs (`skills`, `plugins`, `projects`, `agents`,
 * `commands`) as symlinks back to the default `~/.claude`, so a session started
 * on one seat can be resumed from another (transcripts live under `projects`).
 * Loose config files mirror default -> seat when the default copy is newer, and
 * the project trust map from `~/.claude.json` is merged into each seat dir's
 * `.claude.json` (missing keys only) so a repo trusted once is trusted on every
 * seat — trust prompts never block a rotated continuation.
 *
 * Data-safety law (learned upstream in ADE, 2026-07-16): a Claude spawned
 * before the symlink existed creates a REAL per-seat dir and writes transcripts
 * there; linking over it destroys sessions. Merge into shared first, never
 * overwrite, never delete; anything locked stays for the next sync.
 *
 * Ported (minimally) from ADE `src/main/lib/accounts-sync.ts` (2026-08-21).
 *
 * @module claudeSeatSync
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import type { ClaudeSeat } from "./claudeSeatGuard.ts";

const SHARED_DIRS = ["skills", "plugins", "projects", "agents", "commands"];
const SHARED_FILES = ["CLAUDE.md", "keybindings.json"];

// exported for tests: merge base's project trust entries into the seat's
// config, never touching seat identity
export function mergeTrustedProjects(
  base: { projects?: Record<string, unknown> },
  seat: Record<string, unknown> & { projects?: Record<string, unknown> },
): { merged: Record<string, unknown>; added: number } {
  const merged = { ...seat, projects: { ...(seat.projects ?? {}) } };
  let added = 0;
  for (const [k, v] of Object.entries(base.projects ?? {})) {
    if (!(k in merged.projects)) {
      merged.projects[k] = v;
      added += 1;
    }
  }
  return { merged, added };
}

// Move every file under `from` into `to` (recursive, never overwrites, per-file
// try — an open handle just stays for the next sync). Returns files moved.
function mergeDirInto(from: string, to: string): number {
  let moved = 0;
  NodeFS.mkdirSync(to, { recursive: true });
  for (const e of NodeFS.readdirSync(from, { withFileTypes: true })) {
    const src = NodePath.join(from, e.name);
    const dst = NodePath.join(to, e.name);
    try {
      if (e.isDirectory()) {
        moved += mergeDirInto(src, dst);
        try {
          NodeFS.rmdirSync(src);
        } catch {
          /* not empty yet */
        }
      } else if (!NodeFS.existsSync(dst)) {
        NodeFS.renameSync(src, dst);
        moved += 1;
      }
      // dst already exists: leave src in place — never overwrite, never delete
    } catch {
      /* locked/open file: retry next sync */
    }
  }
  return moved;
}

/**
 * Discover logged-in seats: the default `~/.claude` plus `~/.claude-acct2..9`,
 * a dir counting only when its `.credentials.json` exists. Mirrors ADE's
 * filesystem discovery so both fleets see the same seat pool.
 */
export function discoverSeats(home: string = NodeOS.homedir()): ClaudeSeat[] {
  const out: ClaudeSeat[] = [];
  if (NodeFS.existsSync(NodePath.join(home, ".claude", ".credentials.json"))) {
    out.push({ name: "acct1", configDir: null });
  }
  for (let i = 2; i <= 9; i++) {
    const dir = NodePath.join(home, `.claude-acct${i}`);
    if (NodeFS.existsSync(NodePath.join(dir, ".credentials.json"))) {
      out.push({ name: `acct${i}`, configDir: dir });
    }
  }
  return out;
}

/** Scaffold shared state into every existing seat dir. Returns human-readable notes. */
export function syncSeatDirs(home: string = NodeOS.homedir()): string[] {
  const notes: string[] = [];
  const def = NodePath.join(home, ".claude");
  for (let i = 2; i <= 9; i++) {
    const dir = NodePath.join(home, `.claude-acct${i}`);
    if (!NodeFS.existsSync(dir)) continue;
    for (const d of SHARED_DIRS) {
      const src = NodePath.join(def, d);
      const dst = NodePath.join(dir, d);
      if (!NodeFS.existsSync(src)) continue;
      const st = NodeFS.existsSync(dst) ? NodeFS.lstatSync(dst) : null;
      if (st?.isSymbolicLink()) continue; // already linked
      if (st?.isDirectory()) {
        // a REAL dir means a spawn beat the link: rescue its contents into shared first
        try {
          const moved = mergeDirInto(dst, src);
          if (moved) notes.push(`acct${i}: rescued ${moved} file(s) from real ${d} into shared`);
          NodeFS.rmdirSync(dst); // throws while anything (an open transcript) remains — retry next sync
        } catch {
          continue;
        }
      }
      try {
        NodeFS.symlinkSync(src, dst, "junction");
        notes.push(`acct${i}: linked ${d}`);
      } catch {
        /* next sync */
      }
    }
    for (const f of SHARED_FILES) {
      const src = NodePath.join(def, f);
      const dst = NodePath.join(dir, f);
      if (!NodeFS.existsSync(src)) continue;
      try {
        const sm = NodeFS.statSync(src).mtimeMs;
        if (!NodeFS.existsSync(dst) || NodeFS.statSync(dst).mtimeMs < sm - 1000) {
          NodeFS.copyFileSync(src, dst);
          notes.push(`acct${i}: synced ${f}`);
        }
      } catch {
        /* next sync */
      }
    }
    try {
      const baseP = NodePath.join(home, ".claude.json");
      const seatP = NodePath.join(dir, ".claude.json");
      if (NodeFS.existsSync(baseP) && NodeFS.existsSync(seatP)) {
        const base = JSON.parse(NodeFS.readFileSync(baseP, "utf8")) as {
          projects?: Record<string, unknown>;
        };
        const seat = JSON.parse(NodeFS.readFileSync(seatP, "utf8")) as Record<string, unknown>;
        const { merged, added } = mergeTrustedProjects(base, seat);
        if (added > 0) {
          NodeFS.writeFileSync(seatP, JSON.stringify(merged, null, 2));
          notes.push(`acct${i}: +${added} trusted projects`);
        }
      }
    } catch {
      /* malformed json: leave it alone */
    }
  }
  return notes;
}

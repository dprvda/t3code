---
name: package-delivery
description: Deterministic QC gate on a master before it goes out — refuses silent audio, black frames, clipping and a broken loop, then emits a signed delivery manifest.
---

# Check the master before delivery

The last gate before something leaves the studio. It is deterministic: ffmpeg
measurements only, no model, no network, no judgement. It either signs the master
off or refuses it, and **the refusal has no override in this skill** — that is
deliberate. A master that fails here does not ship.

## Steps

1. **Find the master.** The manager drags it in; uploads land in
   `<workspace>/uploads/`. Use the absolute path.

2. **Run the gate:**

   ```bash
   cd /home/dprvd/work/carbon-proposal/agent
   node skills/package-master/run.mjs <abs path to master> \
     [--require-audio] [--loop] [--targets 9:16,1:1] \
     --manifest <workspace>/artifacts/delivery-manifest.json
   ```

   Set the flags from what the manager told you:
   - `--require-audio` if the deliverable has a soundtrack (a silent master is
     one of the most common and most embarrassing delivery failures);
   - `--loop` if it is a loop — checks the seam;
   - `--targets` for every ratio being delivered, so the safe-area/crop maths is
     checked for each.

3. **Report the verdict, exactly as the gate gave it.**

   - **Refused** — lead with it. State every failed check and its measured
     number. Do not soften it, do not suggest shipping anyway, and do not offer
     a way around the gate. Tell the manager what to fix.
   - **Passed** — say what was checked and point at the manifest under
     `artifacts/`.

## Rules

- **Never override a refusal.** Not with a flag, not by re-running with checks
  removed, not by re-encoding the file to make it pass. If the manager insists,
  tell them the gate is deterministic and the file needs fixing.
- **Never edit the master.** This skill measures. It does not re-encode, trim,
  normalise or "fix" anything — the checker never touches pixels.
- **Never deliver.** It produces a manifest. Sending the file to a client is a
  human action, outside this skill.
- Report the real numbers, not "looks fine".

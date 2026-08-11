# Model Selection — Preserving Landscape Geometry

Model lineups and capabilities change monthly. Treat this file as living doc:
verify what's actually offered in Higgsfield (or other connected tools) at
production time and update the table. The *selection principles* are stable even
when the model names aren't.

## Selection principles (stable)

Geometry preservation, best to worst, by conditioning type:

1. **Video-to-video restyle** — input is the real Earth Studio render; the model
   re-lights and re-textures but the camera path and geography are pinned by real
   pixels. Least drift. Use when the Earth Studio move is good and the model/tier
   supports v2v.
2. **First + last frame image-to-video** — the model must start AND end on real
   geography; drift is squeezed from both directions. The workhorse mode.
   (Kling and Seedance both offer start/end-frame conditioning on current tiers.)
3. **Single-image i2v with camera control** — Higgsfield's camera-move presets
   (drone push-in, crane, etc.) help the motion match the brief, but the far end
   of the hole is the model's invention. Most drift; most QC rejections. Only for
   Path-C (screenshot-only) source material.

Secondary criteria, in order: photorealism at landscape scale (no "render" look) ·
camera-path adherence · duration per generation (10s+ reduces edit points) ·
cost per test iteration (cheap tests matter more than cheap finals).

## Candidate models via Higgsfield (verify availability at production time)

| Model | Modes to prefer | Notes for this use case |
|---|---|---|
| Kling (2.x pro tiers) | start+end frame i2v | Strong prompt adherence and landscape realism; good duration options; the default first pick for keyframe-conditioned holes |
| Seedance (pro) | start+end frame i2v | Very strong motion smoothness; competitive realism; good second opinion when Kling drifts on a specific hole |
| Veo (3.x) | i2v, v2v where offered | Top-tier photorealism; camera-language comprehension is excellent; watch cost per generation — use for hero holes / finals if tests show it preserves geometry better |
| Higgsfield native camera presets | applied over i2v | Use the drone/aerial presets to enforce the camera grammar; pair with a conditioning mode above, not as a substitute for one |
| Minimax/Hailuo, Wan, others | i2v | Bench options if the primaries fail a specific hole; same test protocol |

## Standard evaluation protocol (per model, once per course)

Run ONE bake-off on the pilot hole before committing the course to a model:

1. Same source frames, same assembled prompt, same 5s test segment on each
   candidate model (2–3 models max).
2. Score each against the Step-8 drift checklist (bunkers, water, green, trees,
   fairway, horizon, buildings) — pass/fail per feature, then overall realism 1–5.
3. Record scores + credits spent in `production-log.md`.
4. Winner becomes the course default (`course.json` prompt.model on every hole);
   runner-up is the designated fallback for holes that fail twice.

One model for all 18 holes unless it fails — consistency beats per-hole
optimization.

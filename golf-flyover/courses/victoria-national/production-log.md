# Production Log — Victoria National Golf Club

Every generation attempt gets an entry — model, mode, settings, credits, QC verdict.
Nothing gets generated without being logged.

## Credit ledger

| Date | Hole | Model | Type | Credits | Result |
|---|---|---|---|---|---|

## Log

<!--
### YYYY-MM-DD — Hole N — attempt X
- Model / mode / settings:
- Prompt version: (link to course.json state / commit)
- Credits spent:
- QC verdict: pass | fail (which features drifted)
- Decision: approve | revise (which revision-ladder rung) | switch model
-->

### 2026-08-11 — Course setup + Hole 18 (pilot) planned — Steps 1-5
- Tees locked: WHITE (6,404 yds) — right fit for mid-to-high handicap presentation.
- Pilot hole chosen: 18 (par 4, 390). Rationale: gentle dogleg right + fairway
  bunker cluster + water in play tee-to-green + clubhouse landmark = exercises
  every QC dimension incl. building preservation. Backup candidate: 14 (straight,
  water left, lowest camera complexity — reference saved).
- Geography sourced WITHOUT generation credits: BlueGolf scorecard (all tees),
  OSM course mapping (18 hole routings, 59 bunkers, water), Esri World Imagery
  (visual verification, orthos saved to references/), USGS 3DEP elevations.
- course.json filled for all 18 holes (par/yardage/handicap/tee+green coords);
  hole 18 fully planned: features, geography clause, shot plan, assembled prompt.
- Earth Studio capture recipe written: references/hole18_earthstudio_recipe.md.
- Credits spent: 0. Next: user captures Earth Studio move -> keyframe extraction
  -> model bake-off (one 5s test per candidate model) per prompts/MODEL-SELECTION.md.

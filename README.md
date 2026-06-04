# 🎭 Line Coach

A simple, no-install website to help actors memorise their **play lines** and the
**cue lines** that come before them. Everything runs in your browser — no server,
no accounts, no sign-up. Your scripts are saved locally on your device.

## Open it

Just open `index.html` in any modern browser. That's it.

(Or host the three files — `index.html`, `styles.css`, `app.js` — anywhere, e.g.
GitHub Pages.)

## How to use

1. **Library** → *New Script* (or *Load sample scene* to try it out).
2. **Script** → paste your script and click *Parse & Save*. Use the format:

   ```
   JULIET: O Romeo, Romeo! wherefore art thou Romeo?
   ROMEO: Shall I hear more, or shall I speak at this?
   ```

   - One speech per line as `CHARACTER: dialogue`.
   - Long speeches can wrap onto continuation lines (no colon needed).
   - Lines in `(parentheses)` or `[brackets]` are kept as stage directions.
   - Then pick **"I am playing:"** to tell the app which lines are yours.

3. **Rehearse** → read through the scene with **your lines hidden**. The speech
   right before each of your lines (your **cue**) is highlighted. Tap a hidden
   line to reveal and check yourself. Toggles let you show/hide your lines or
   turn off cue highlighting.

4. **Cue Cards** → flashcard drills. You see the **cue**, recite your line from
   memory, then *Reveal*. Mark **Got it ✓** or **Missed ✗** to track progress,
   *Shuffle* the order, or **Drill missed only** to focus on weak spots.

### Keyboard shortcuts (Cue Cards)

| Key | Action |
| --- | --- |
| `Space` / `Enter` | Reveal your line |
| `→` / `←` | Next / previous card |
| `G` | Mark *Got it* |
| `M` | Mark *Missed* |

## Backup & sharing

Use **Export** on the Script tab to save a script as a `.json` file, and
**Import** in the Library to load it back (handy for moving between devices or
sharing a scene with a scene partner).

## Notes

- Data is stored in your browser's `localStorage` under the key `lineCoach.v1`.
  Clearing your browser data will remove saved scripts — export anything you want
  to keep.

# Teamwork Bloomington — Business Scoreboard

The main project in this repository is the **Teamwork Bloomington business
scoreboard**: a self-updating command center for leads, conversions,
athletes, retention, revenue, team scorecards, 5-15 reports, operations &
cleaning checklists, onboarding, and marketing/3R tracking.

**➜ Everything lives in the [`teamwork-scoreboard/`](teamwork-scoreboard/) folder.**

| If you want to… | Go to |
| --- | --- |
| Set it up from scratch (owner's plain-English checklist) | [`teamwork-scoreboard/docs/SETUP-GUIDE.md`](teamwork-scoreboard/docs/SETUP-GUIDE.md) |
| Read the technical overview & deployment docs | [`teamwork-scoreboard/README.md`](teamwork-scoreboard/README.md) |
| Learn how CSV / Google Sheets / Zen Planner data flows in | [`teamwork-scoreboard/docs/DATA-MAPPING.md`](teamwork-scoreboard/docs/DATA-MAPPING.md) |

**Quick start** (after installing [Node.js LTS](https://nodejs.org)):

```bash
cd teamwork-scoreboard
npm install
npm run db:seed
npm run dev
```

Then open <http://localhost:3000> and sign in with the demo logins printed in
your terminal (password `teamwork1`).

---

### Also in this repository

- **Line Coach** — a small stand-alone website for actors memorising lines
  (`index.html`, `app.js`, `styles.css`, `LineCoach.html`). Its instructions
  moved to [`LINECOACH.md`](LINECOACH.md). It is unrelated to the scoreboard.

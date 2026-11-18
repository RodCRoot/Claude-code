---
type: policy
area: customer-service-bot
status: confirmed
updated: 2026-11-18
tags: [cs-bot, routing, linton]
---

# Fitness Together and Linton

Part of [[Customer Service Bot]]. Rod does not want to deal with these questions at all.

**Fitness Together** in **Linton, Indiana** is a separate business run by **Mary Hogue**. The bot answers nothing about it (schedule, pricing, programs). It does **not** take a message or promise a callback. It **gives Mary's number and stops**.

**Mary Hogue: (812) 381-1217**

- Text: "That's Fitness Together over in Linton, that's Mary Hogue's, not ours. You can reach her at (812) 381-1217."
- Voice: say it digit by digit, "eight one two, three eight one, one two one seven", then **offer to text it**.

## Trigger precisely
| Caller | Action |
|---|---|
| Asks about Fitness Together | hand off Mary's number |
| Asks about the gym in Linton | hand off Mary's number |
| "I live in Linton, do you train athletes?" | **our lead**, book the [[Free Assessment]] |
| Existing member who lives near Linton | ours, handle normally |

Route on the business, not the geography. (Linton classes are deliberately excluded from Bloomington memberships in ZenPlanner.)

Open: Mary's email, and whether to loosen the rule to any mention of Linton ([[Open Questions]]).

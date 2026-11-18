---
type: tracker
area: customer-service-bot
status: open
updated: 2026-11-18
tags: [cs-bot, todo, open-questions]
---

# Open Questions

Part of [[Customer Service Bot]]. Strike through as answered.

## Blocking launch
- [ ] **Bot name**, and does it disclose being an AI on calls?
- [ ] **What sports** do you specialize in? (early qualifying question)
- [ ] **Who exactly receives** escalation email / SMS (addresses and numbers)? ([[Escalation Routing]])
- [ ] **Angela**: does the new bot replace her or run alongside? Her call recaps never reach GHL, so cancellation requests are lost right now. ([[Systems and Integrations]])
- [ ] **A2P 10DLC** registration current? STOP handling works?

## Flows still unwritten
- [ ] **Adjusting a membership:** drop 3x to 2x mid-commitment, allowed? effective when? prorated? fee? extends the commitment? upgrades? can the bot answer or always hand off?
- [ ] **After the assessment:** how do they sign up (on the spot, staff builds it, a link)? Does the bot touch signup?
- [ ] **Waiver:** exists? when signed? what to bring (default: workout clothes, training shoes, water)
- [ ] **Holds:** min/max length, fee, does a hold push the commitment end date out?

## Policy gaps
- [ ] Refund policy; cancellation fees after 28 days; late/no-show; guest policy; weather closures; holidays; photo release; gym rules
- [ ] Drop-in, 1-on-1/semi-private, team training: offered? priced?
- [ ] Does the [[Family Discount]] apply to In Season, the 6-week challenge, College Athlete Weekly?
- [ ] 4x per week = 16 sessions/month? (inferred)
- [ ] Make-ups: floor each month at zero, or net across the window? Punch-card expiration (suggested 3 months)? ([[Make-Up Sessions]])
- [ ] Mary's email; loosen the Linton rule to any mention of Linton? ([[Fitness Together and Linton]])

## Screenshots needed
- [ ] Staff-side: reserving an athlete into a class (for Bobby)
- [ ] The custom-membership **punch-card builder** settings

## ZenPlanner clean-up (not bot work)
- [ ] "1x per Week Month to Month" template has a 3-month duration
- [ ] In Season template auto-renew ON; College Athlete Weekly auto-renew ON ([[Rate Card]])
- [ ] Queued renewal terms and autopay bills for members who are really month-to-month ([[Cancellation and Commitments]])
- [ ] Give Bobby a separate ZenPlanner login and confirm no session collision ([[Late Reservation and 2-Hour Cutoff]])

## Biggest lever
- [ ] Run `cs-bot/ghl_export.py` and read real transcripts. Everything here is policy-as-documented; transcripts show policy-as-practiced and Rod's actual voice.
- [ ] Voice: phrases Rod always uses with parents; anything that would make him wince.

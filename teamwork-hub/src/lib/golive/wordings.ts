import { ACH_MANDATE_WORDING } from "@/lib/billing/mandate-text";
import { ESIGN_CONSENT_WORDING } from "@/lib/forms/consent";
import { CARD_UPDATE_WORDING } from "@/lib/messaging/family-style";
import { NEWS_WATCH_WORDING } from "@/lib/newswatch/shared";
import type { Wording } from "@/lib/sample-text";
import { SHOWCASE_CONSENT_WORDING } from "@/lib/showcase/allowlist";
import { WINS_MARKETING_WORDING } from "@/lib/wins/shared";

/**
 * Every piece of family-facing wording that lives in the code (not in a form or message template).
 * Each is declared next to its text with `defineWording`; add new ones here so the go-live page
 * lists them. Form templates, message templates and the referral text carry the same flag in the
 * database and are read there.
 */
export const BUILT_IN_WORDINGS: Wording[] = [ESIGN_CONSENT_WORDING, ACH_MANDATE_WORDING, SHOWCASE_CONSENT_WORDING, NEWS_WATCH_WORDING, WINS_MARKETING_WORDING, CARD_UPDATE_WORDING];

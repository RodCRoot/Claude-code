/**
 * Session check-in question set: every word an athlete or parent reads, in one place.
 * Pure module (safe to import from client components).
 *
 * WORDING_VERSION changes whenever any wording or scale below changes. Each stored answer keeps
 * `<WORDING_VERSION>.<organization revision>` so history stays readable after edits.
 * The wording is written for a 10 year old and an adult alike, makes no medical claim, and has
 * no em dashes (family-facing text rule).
 */
export const WORDING_VERSION = 1;

export type ScaleOption = { value: number; label: string; face?: string };

/** Ready check Q1. 1 to 5. */
export const READINESS = {
  key: "readiness",
  question: "How ready do you feel today?",
  options: [
    { value: 1, label: "Not ready", face: "😫" },
    { value: 2, label: "A bit off", face: "😕" },
    { value: 3, label: "OK", face: "😐" },
    { value: 4, label: "Good", face: "🙂" },
    { value: 5, label: "Ready to go", face: "😄" },
  ] satisfies ScaleOption[],
};

/** Same item as the daily wellness `sleep_quality` (1 to 5, higher is better). */
export const SLEEP_QUALITY = {
  key: "sleep_quality",
  question: "How did you sleep last night?",
  options: [
    { value: 1, label: "Very poor" },
    { value: 2, label: "Poor" },
    { value: 3, label: "OK" },
    { value: 4, label: "Good" },
    { value: 5, label: "Excellent" },
  ] satisfies ScaleOption[],
};

/** Same item as the daily wellness `sleep_hours`. */
export const SLEEP_HOURS = { key: "sleep_hours", question: "About how many hours did you sleep?", hint: "Optional. A guess is fine." };

/** 0 to 10 slider with word anchors. */
export const SORENESS = {
  key: "soreness",
  preQuestion: "How sore are your muscles right now?",
  postQuestion: "How sore are you right now?",
  anchors: { 0: "Not sore", 3: "A little", 5: "Sore", 7: "Very sore", 10: "Worst ever" } as Record<number, string>,
};

export function sorenessWord(v: number): string {
  if (v <= 0) return "Not sore";
  if (v <= 3) return "A little sore";
  if (v <= 5) return "Sore";
  if (v <= 8) return "Very sore";
  return "Worst ever";
}

/** Same item as the daily wellness `fatigue` (1 to 5, lower is better). */
export const FATIGUE = {
  key: "fatigue",
  question: "How tired do you feel?",
  options: [
    { value: 1, label: "Fresh" },
    { value: 2, label: "Pretty good" },
    { value: 3, label: "A bit tired" },
    { value: 4, label: "Tired" },
    { value: 5, label: "Exhausted" },
  ] satisfies ScaleOption[],
};

/** Same item as the daily wellness `mood` (1 to 5, higher is better). */
export const MOOD = {
  key: "mood",
  question: "How is your mood?",
  options: [
    { value: 1, label: "Low" },
    { value: 2, label: "Meh" },
    { value: 3, label: "OK" },
    { value: 4, label: "Good" },
    { value: 5, label: "Great" },
  ] satisfies ScaleOption[],
};

/** Same item as the daily wellness `stress` (1 to 5, lower is better). Off by default. */
export const STRESS = {
  key: "stress",
  question: "How stressed do you feel?",
  options: [
    { value: 1, label: "Relaxed" },
    { value: 2, label: "Calm" },
    { value: 3, label: "A little" },
    { value: 4, label: "Stressed" },
    { value: 5, label: "Very stressed" },
  ] satisfies ScaleOption[],
};

export const PRIOR_SORENESS = { key: "prior_soreness", question: "How sore were you the day after your last session?", hint: "0 = not sore, 10 = worst ever" };

export const HURT = {
  preQuestion: "Does anything hurt today?",
  postQuestion: "Did anything hurt or not feel great?",
  preToggle: "Something hurts",
  where: "Where? Tap the spot.",
  typeQuestion: "What does it feel like?",
  types: [
    { value: "ache", label: "Achy or tight", hint: "Dull, like sore muscles" },
    { value: "sharp", label: "Sharp pain", hint: "Sudden, stabbing or pinching" },
  ] as const,
  levelQuestion: "How much does it bother you?",
  /** checkin_pain_level_v1: three plain choices stored on the body map's 0 to 10 severity scale. */
  levels: [
    { value: 3, label: "A little" },
    { value: 6, label: "Quite a bit" },
    { value: 9, label: "A lot" },
  ] as const,
  startedQuestion: "Did it start during this session?",
  sharpNote: "Sharp pain is worth speaking up about. Please tell your coach and a parent now. This app cannot tell you what is wrong or whether it is safe to train.",
  hurtNote: "Thanks for telling us. Your coach will see this before you start.",
};

export const PRE_NOTE = { question: "Anything your coach should know today?", hint: "Optional. For example: big game yesterday, long school day, new shoes." };

/** Session RPE, CR-10 style. Feeds srpe_load_v1 with the session's minutes. */
export const RPE = {
  key: "rpe",
  question: "How hard was the session?",
  options: [
    { value: 0, label: "Rest" },
    { value: 1, label: "Very easy" },
    { value: 2, label: "Easy" },
    { value: 3, label: "Moderate" },
    { value: 4, label: "Somewhat hard" },
    { value: 5, label: "Hard" },
    { value: 6, label: "Hard" },
    { value: 7, label: "Very hard" },
    { value: 8, label: "Very hard" },
    { value: 9, label: "Almost max" },
    { value: 10, label: "Max effort" },
  ] satisfies ScaleOption[],
};
export const rpeWord = (v: number) => RPE.options.find((o) => o.value === v)?.label ?? "";

export const LIKED = { question: "What did you like?", hint: "Tap any that fit.", textLabel: "Anything else you liked?" };
export const DISLIKED = {
  question: "Anything you did not like or want changed?",
  hint: "Optional. Honest answers help us get better, and nobody gets in trouble.",
  nothing: "Nothing, it was good",
  textLabel: "Tell us more",
};

/** The existing 1 to 5 session rating (same labels as before). */
export const RATING = {
  question: "Overall, how was the session?",
  options: [
    { value: 1, label: "Poor" },
    { value: 2, label: "Not great" },
    { value: 3, label: "OK" },
    { value: 4, label: "Good" },
    { value: 5, label: "Great" },
  ] satisfies ScaleOption[],
};

export const POST_NOTE = { question: "Any other notes?", hint: "Optional. Read by the owner and front desk. Please do not put medical details here." };

export const TELL_COACH = {
  label: "Show my coach my name with my likes, dislikes and rating",
  hint: "If you leave this off, coaches only see class totals for those answers.",
};

export const DISCLAIMER = "These are your own answers. They are not a diagnosis and do not clear anyone to train. See a qualified medical professional for injuries.";

export type ChipDef = { key: string; label: string };

/** DEFAULT chips: starting points an owner can edit in Settings. */
export const DEFAULT_LIKED_CHIPS: ChipDef[] = [
  { key: "lifting", label: "Lifting" },
  { key: "speed_work", label: "Speed work" },
  { key: "jumps", label: "Jumps" },
  { key: "competing", label: "Competing" },
  { key: "my_coach", label: "My coach" },
  { key: "my_group", label: "My group" },
  { key: "learned_something_new", label: "Learned something new" },
  { key: "it_was_fun", label: "It was fun" },
];

export const DEFAULT_DISLIKED_CHIPS: ChipDef[] = [
  { key: "too_hard", label: "Too hard" },
  { key: "too_easy", label: "Too easy" },
  { key: "too_crowded", label: "Too crowded" },
  { key: "too_much_waiting", label: "Too much waiting" },
  { key: "did_not_understand_something", label: "Did not understand something" },
  { key: "ran_out_of_time", label: "Ran out of time" },
];

/** Turn a label into a stable chip key. */
export function chipKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

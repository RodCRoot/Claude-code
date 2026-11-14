/**
 * The one machine-readable marker for wording that has not been approved yet.
 *
 * Three places hold family-facing wording, and each carries the same boolean:
 * - form template versions: `form_template_versions.is_sample_text`
 * - message templates: `message_templates.is_sample`
 * - wording built into the code or kept in settings: a `Wording` made with `defineWording`
 *   (`isSample`), or an `...IsSample` flag stored next to the text in settings.
 *
 * Nothing decides "is this sample?" by reading the prose. The words "SAMPLE TEXT" inside a body are
 * for the reader only; the go-live page (src/lib/golive) and the campaign guard read the flag.
 */
export type Wording = {
  /** Stable id, used by the go-live page. */
  id: string;
  /** What an owner would call it. */
  label: string;
  /** Version string stored with every acceptance of this wording. */
  version: string;
  /** True until the real, approved wording replaces the placeholder. */
  isSample: boolean;
  /** Where a family sees it. */
  shownAt: string;
  /** Source file to change when the approved wording arrives (built-in wording is changed in code). */
  source: string;
  /** A page in the app where an owner can read the current wording, or the setting that holds it. */
  href: string;
};

export function defineWording(w: Wording): Wording {
  return Object.freeze({ ...w });
}

/**
 * Seeds and "create a starter template" code write this instead of a bare `true`, so every place
 * that plants sample wording is findable with one search.
 */
export const SEEDED_AS_SAMPLE = true as const;

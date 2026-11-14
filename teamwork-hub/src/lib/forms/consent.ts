/**
 * The exact electronic-signature consent statement shown next to the signing
 * checkbox. It is stored verbatim in every signature row, so changing this text
 * only affects future signatures. Bump the version label when it changes.
 *
 * SAMPLE language: Teamwork must have this reviewed before production use.
 */
export const ESIGN_CONSENT_VERSION = "pilot-2026-1";

export const ESIGN_CONSENT_TEXT =
  `[Consent ${ESIGN_CONSENT_VERSION}] I agree to sign this document electronically. ` +
  "By typing my full legal name and checking this box, I intend my typed name to be my signature on this document, " +
  "I confirm that I have read the document shown above in full, that the information I submitted is accurate, " +
  "and that I am the person named as the signer (or am authorized to sign in the role shown). " +
  "I understand I can request a paper copy from Teamwork staff and can download a PDF copy of the completed document.";

export const PILOT_NOTICE =
  "This typed-name signing workflow is a verifiable pilot: it records who signed, when, from where, how their identity " +
  "was checked, and exactly what they signed, and seals that evidence with a SHA-256 integrity hash. It is not a " +
  "complete production e-signature system, and Teamwork Hub makes no claim about the legal enforceability of " +
  "documents signed this way.";

/** Shown wherever signing happens: how identity verification (step-up) works. */
export const IDENTITY_NOTICE =
  "For forms that require identity verification (by default waivers and agreements), a signature is accepted only " +
  "after the signer enters a one-time 6-digit code emailed to the address Teamwork has on file (valid 10 minutes, " +
  "5 attempts), or — if the organization allows it — after signing in with multi-factor authentication. When email " +
  "is not available, Teamwork staff can check the signer's identity in person and record the signature as a " +
  "witness. The method used is recorded with the signature and printed on the completed PDF. Identity checks " +
  "reduce the risk of someone signing in another person's name; they do not by themselves make a document legally " +
  "enforceable.";

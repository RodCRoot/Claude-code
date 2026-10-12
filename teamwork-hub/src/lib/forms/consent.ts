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
  "This typed-name signing workflow is a verifiable pilot: it records who signed, when, from where, and exactly what " +
  "they signed, and seals that evidence with a SHA-256 integrity hash. It is not a complete production e-signature " +
  "system, and Teamwork Hub makes no claim about the legal enforceability of documents signed this way.";

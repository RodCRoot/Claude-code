/**
 * Business-rule error thrown by CRM/messaging/automation domain code.
 * Kept free of `server-only` so the job worker (plain Node via tsx) can import the
 * domain modules; server actions translate it into `UserError` (see `domainAction`).
 */
export class DomainError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

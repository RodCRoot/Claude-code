/**
 * Business-rule error from billing domain code. Kept free of "server-only" so domain functions
 * run in seeds, workers and tests; billing server actions translate it into an ActionState.
 */
export class UserError extends Error {
  constructor(
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "BillingUserError";
  }
}

/** Thrown when an event references something not recorded yet (e.g. refund before charge). Retried later. */
export class DeferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferError";
  }
}

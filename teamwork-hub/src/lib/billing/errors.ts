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

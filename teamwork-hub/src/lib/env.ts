import { z } from "zod";

/**
 * Environment validation. Secrets are only ever read here, on the server.
 * Optional provider variables leave their integration in "not_configured" state —
 * the app keeps working and says so honestly.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** "demo" enables synthetic seed + dev role switcher; never set in production. */
  APP_MODE: z.enum(["demo", "staging", "production"]).default("demo"),
  /** Object storage: "local" (STORAGE_DIR on disk) or "s3" (S3-compatible bucket). */
  STORAGE_BACKEND: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default("./.storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  /** Only for S3-compatible providers (R2, B2, MinIO); omit for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  S3_PREFIX: z.string().optional(),
  S3_SSE: z.enum(["AES256", "aws:kms", "none"]).default("AES256"),
  S3_KMS_KEY_ID: z.string().optional(),
  // Credentials: standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, profile, role).

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),

  HAWKIN_REFRESH_TOKEN: z.string().optional(),
  HAWKIN_API_BASE: z.string().url().default("https://cloud.hawkindynamics.com/api"),
  HAWKIN_ORG_SCOPE: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  EMAIL_PROVIDER: z.enum(["none", "smtp", "postmark", "sendgrid"]).default("none"),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMS_PROVIDER: z.enum(["none", "twilio"]).default("none"),
  SMS_ACCOUNT_SID: z.string().optional(),
  SMS_AUTH_TOKEN: z.string().optional(),
  SMS_FROM: z.string().optional(),
  /** Comma-separated allowlist; when set, all external delivery is redirected here. */
  DELIVERY_TEST_RECIPIENTS: z.string().optional(),
  /** Must be explicitly "true" for any real external delivery. */
  DELIVERY_ENABLED: z.enum(["true", "false"]).default("false"),

  /** Optional site-wide HTTP Basic Auth gate for a private staging deployment (src/proxy.ts). */
  STAGING_BASIC_AUTH_USER: z.string().optional(),
  STAGING_BASIC_AUTH_PASSWORD: z.string().min(16, "STAGING_BASIC_AUTH_PASSWORD must be at least 16 characters").optional(),

  /** Server-side error reporting; Sentry is never loaded without it. */
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((e, ctx) => {
  if (e.STORAGE_BACKEND === "s3") {
    for (const k of ["S3_BUCKET", "S3_REGION"] as const) {
      if (!e[k]) ctx.addIssue({ code: "custom", path: [k], message: `${k} is required when STORAGE_BACKEND=s3` });
    }
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // `FOO=` in an env file means "unset", not an (invalid) empty value.
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  if (parsed.data.APP_MODE === "production" && parsed.data.NODE_ENV !== "production") {
    throw new Error("APP_MODE=production requires NODE_ENV=production");
  }
  cached = parsed.data;
  return cached;
}

export const isDemoMode = () => env().APP_MODE === "demo";

/** Names of configuration variables per integration — values are never exposed. */
export const integrationEnvVars: Record<string, string[]> = {
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"],
  paypal: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_ENV"],
  venmo: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID (Venmo runs through PayPal Checkout)"],
  hawkin: ["HAWKIN_REFRESH_TOKEN", "HAWKIN_API_BASE", "HAWKIN_ORG_SCOPE"],
  google_calendar: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  email: ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"],
  sms: ["SMS_PROVIDER", "SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"],
};

export function hasEnv(...names: string[]): boolean {
  return names.every((n) => !!process.env[n]);
}

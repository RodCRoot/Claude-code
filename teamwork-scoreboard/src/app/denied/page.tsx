import { ButtonLink } from "@/components/ui";

export default function DeniedPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-bold">Not authorized</h1>
      <p className="max-w-md text-sm text-ink-2">
        Your role does not have access to that area. Ask an administrator to
        adjust role permissions in Admin → Users &amp; Roles if you need it.
      </p>
      <ButtonLink href="/" variant="secondary">
        Back to Today
      </ButtonLink>
    </div>
  );
}

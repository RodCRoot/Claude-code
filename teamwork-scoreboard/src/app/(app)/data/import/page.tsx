import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import Data" };

export default async function ImportPage() {
  await requireUser("manage_imports");
  return (
    <>
      <PageHeader
        kicker="Data & Sync"
        title="Import CSV / Google Sheets"
        subtitle="Upload an export or point at a shared sheet, map the columns once, and reuse the mapping every time."
        actions={
          <Link href="/data" className="text-sm font-medium text-brand-600 hover:underline">
            ← Data &amp; Sync
          </Link>
        }
      />
      <ImportWizard />
    </>
  );
}

import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { ZP_GRID_SCHEMAS } from "@/lib/imports/schemas/zenplanner-grid";
import { formatMoney } from "@/lib/money";
import { CATALOG_LABEL, catalogStatus, EVENT_CANDIDATES } from "@/lib/zenplanner/catalog";
import { PROSPECT_STATUS_TO_STAGE, VOCAB_KEYS, vocabOverrides, ZP_VOCAB } from "@/lib/zenplanner/vocab";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, buttonClass, Callout, Card, CardBody, CardHeader, Field, PageHeader, Table, Td, Textarea, Th } from "@/components/ui";
import { ImportTabs } from "../tabs";
import { loadCatalogAction, saveVocabAction } from "./actions";

export const metadata = { title: "Zen Planner import" };

export default async function ZenPlannerImportPage() {
  const v = await requireCap("imports.manage");
  const [catalog, extras] = await Promise.all([catalogStatus(db, v.orgId), vocabOverrides(db, v.orgId)]);
  const loaded = catalog.filter((c) => c.productId).length;
  const isOwner = v.role === "owner";

  return (
    <>
      <PageHeader
        kicker="Import Center"
        title="Zen Planner"
        description="Exact presets for Zen Planner's report grids, the lists that make imported values match, the plan catalog from the real price ladder, and the checks to run after an import. Nothing on these pages writes to Zen Planner."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className={buttonClass("outline")} href="/imports/zenplanner/discounts">
              Discount review
            </Link>
            <Link className={buttonClass("outline")} href="/imports/zenplanner/reconcile">
              Reconciliation
            </Link>
          </div>
        }
      />
      <ImportTabs current="zenplanner" />

      <Callout tone="warn" title="Built from the 2026-11-13 account map; not yet tested against a real export file" className="mb-6">
        The presets use the column names seen in the Zen Planner report grids. The spelling in the CSV file can differ slightly, so headers are matched without regard to capitals or punctuation, with a few alternate spellings per column. Anything the preset does not recognize is listed on the mapping step and left out; the import never fails because of an extra column. Check the first import&apos;s preview carefully.
      </Callout>

      <h2 className="mb-3 text-lg font-semibold">1. Export each grid and import it with its preset</h2>
      <p className="mb-4 text-sm text-ink-3">
        Order matters: Person first (it creates the people, households and guardians the others attach to), then Membership, then Bill and Attendance in any order. Upload each file on the{" "}
        <Link className="underline" href="/imports">
          Imports
        </Link>{" "}
        tab and choose the matching &ldquo;exact preset&rdquo;.
      </p>
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {ZP_GRID_SCHEMAS.map((s) => (
          <Card key={s.id}>
            <CardHeader title={s.label.replace("Zen Planner — ", "")} kicker={s.exportHelp!.grid} />
            <CardBody className="space-y-2 text-sm">
              <p className="text-ink-2">{s.description}</p>
              <ol className="list-decimal space-y-1 pl-5">
                {s.exportHelp!.steps.map((st) => (
                  <li key={st}>{st}</li>
                ))}
              </ol>
              <p>
                <span className="font-medium">Columns to include:</span> {s.exportHelp!.columns.join(", ")}.
              </p>
              <p className="break-all text-xs text-ink-3">
                Grid address: <code>{s.exportHelp!.path}</code>
              </p>
              <details>
                <summary className="cursor-pointer text-xs font-medium">What it does and does not do</summary>
                <p className="mt-1 text-xs text-ink-3">{s.limitations}</p>
              </details>
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="mb-8 text-sm text-ink-3">
        The Task grid (Due, Category, Title, Regarding, Assigned To/By, Status) has no preset: Zen Planner&apos;s open tasks are short-lived staff work and are better re-created here than imported.
      </p>

      <h2 className="mb-3 text-lg font-semibold" id="lists">
        2. Lists that match Zen Planner
      </h2>
      <p className="mb-4 text-sm text-ink-3">
        These are the hub&apos;s default lists for imported values, copied from Zen Planner&apos;s configuration. A value that is not on a list is imported exactly as written and flagged on the row, never rejected. Where the account map names only some of a list&apos;s values, add the rest here so they stop being flagged.
      </p>
      <Card className="mb-4">
        <CardHeader title="Prospect Status → lead stage" />
        <CardBody>
          <Table caption="Prospect status to lead stage mapping">
            <thead>
              <tr>
                <Th>Zen Planner Prospect Status</Th>
                <Th>Hub lead stage</Th>
                <Th>Why</Th>
              </tr>
            </thead>
            <tbody>
              {ZP_VOCAB.prospectStatus.values.map((s) => {
                const m = PROSPECT_STATUS_TO_STAGE[s.toLowerCase()];
                return (
                  <tr key={s}>
                    <Td>{s}</Td>
                    <Td>
                      <code>{m.stage}</code>
                    </Td>
                    <Td>{m.why}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-ink-3">The original Zen Planner status is kept on each imported lead. If a stage was renamed or removed here, the lead goes to the first open stage (or the first lost stage) and the row says so.</p>
        </CardBody>
      </Card>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {VOCAB_KEYS.filter((k) => k !== "prospectStatus").map((k) => {
          const d = ZP_VOCAB[k];
          return (
            <Card key={k}>
              <CardHeader title={d.label} kicker={d.zpField} action={d.complete ? <Badge variant="green">complete</Badge> : <Badge variant="yellow">{`${d.values.length} of ${d.total} known`}</Badge>} />
              <CardBody className="space-y-2 text-sm">
                <p>{d.values.join(" · ")}</p>
                {!d.complete ? <p className="text-xs text-ink-3">The account map names {d.values.length} of this list&apos;s {d.total} values. The others are not invented here: add them below as they are spelled in Zen Planner.</p> : null}
                <ActionForm action={saveVocabAction} className="space-y-2">
                  <input type="hidden" name="key" value={k} />
                  <Field label={`Extra ${d.label} values (one per line)`} htmlFor={`vocab-${k}`}>
                    <Textarea id={`vocab-${k}`} name="values" rows={3} defaultValue={(extras[k] ?? []).join("\n")} />
                  </Field>
                  <SubmitButton variant="outline" size="sm">
                    Save extra values
                  </SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-3 text-lg font-semibold" id="catalog">
        3. Plan catalog from the real price ladder
      </h2>
      <Card className="mb-4">
        <CardHeader
          title="Load Teamwork plan catalog"
          kicker={CATALOG_LABEL}
          action={<Badge variant={loaded === catalog.length ? "green" : loaded ? "yellow" : "neutral"}>{`${loaded} of ${catalog.length} loaded`}</Badge>}
        />
        <CardBody className="space-y-3 text-sm">
          <p>
            Creates one draft plan for each line of the ladder below, with the prices from the owner&apos;s Zen Planner configuration. Drafts are inactive and unlisted: nobody can be sold or billed one until the owner confirms it and turns it on in{" "}
            <Link className="underline" href="/billing/products">
              Billing → Products
            </Link>
            . Running it again creates nothing twice. The demo &ldquo;Sample&rdquo; plans are not changed or removed.
          </p>
          {isOwner ? (
            <ActionForm action={loadCatalogAction}>
              <SubmitButton pendingText="Loading…">Load Teamwork plan catalog</SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-ink-3">Only the owner can load the catalog.</p>
          )}
          <Table caption="Teamwork plan catalog">
            <thead>
              <tr>
                <Th>Plan</Th>
                <Th align="right">Price</Th>
                <Th>Billed</Th>
                <Th>Weekly limit</Th>
                <Th>Commitment</Th>
                <Th>Status here</Th>
                <Th>Not in the configuration map</Th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((c) => (
                <tr key={c.plan.key}>
                  <Td>{c.plan.name}</Td>
                  <Td align="right">{formatMoney(c.plan.priceMinor)}</Td>
                  <Td>{c.plan.interval === "week" ? "weekly" : c.plan.interval === "month" ? "monthly" : "once"}</Td>
                  <Td>{c.plan.unlimited ? "Unlimited" : c.plan.classesPerWeek ? `${c.plan.classesPerWeek} per week` : c.plan.kind === "drop_in" ? "1 visit" : "not set"}</Td>
                  <Td>{c.plan.commitmentMonths ? `${c.plan.commitmentMonths} months` : "none"}</Td>
                  <Td>{c.productId ? c.active ? <Badge variant="green">active</Badge> : <Badge variant="yellow">draft</Badge> : <Badge>not loaded</Badge>}</Td>
                  <Td className="text-xs text-ink-3">{c.plan.unknown ?? ""}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-xs text-ink-3">
            Zen Planner lists 33 membership options. The 20 here are the ones whose price is in the configuration map. Short-run programs are not memberships and are not created; they are candidates for Events:{" "}
            {EVENT_CANDIDATES.map((e) => `${e.name} (${e.price})`).join("; ")}.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

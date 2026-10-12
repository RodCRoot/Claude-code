"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Select, Textarea, buttonClass } from "@/components/ui";

type Result = { ok: boolean; message?: string; error?: string; fieldErrors?: Record<string, string> };

/** Posts multipart to /api/files/archive (route handler, so large PDFs are accepted). */
export function ArchiveUpload({ people }: { people: { id: string; name: string }[] }) {
  const [pending, setPending] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const fe = res?.fieldErrors ?? {};

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setRes(null);
    try {
      const r = await fetch("/api/files/archive", { method: "POST", body: new FormData(e.currentTarget) });
      const body = (await r.json().catch(() => ({ ok: false, error: `Upload failed (${r.status}).` }))) as Result;
      setRes(body);
      if (body.ok) {
        formRef.current?.reset();
        router.refresh();
      }
    } catch {
      setRes({ ok: false, error: "Network error — nothing was saved." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" encType="multipart/form-data">
      <Field label="Person" htmlFor="ar-person" required error={fe.personId}>
        <Select id="ar-person" name="personId" required defaultValue="">
          <option value="" disabled>
            Choose a person…
          </option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Document title" htmlFor="ar-title" required error={fe.title}>
        <Input id="ar-title" name="title" required placeholder="2024 Liability Waiver (paper)" />
      </Field>
      <Field label="Original system" htmlFor="ar-system" required error={fe.originalSystem} hint="Where it was signed, e.g. Zen Planner, paper, DocuSign.">
        <Input id="ar-system" name="originalSystem" required placeholder="Zen Planner" />
      </Field>
      <Field label="Original signed date" htmlFor="ar-date" error={fe.originalSignedDate}>
        <Input id="ar-date" name="originalSignedDate" type="date" />
      </Field>
      <Field label="Original evidence notes" htmlFor="ar-notes" className="sm:col-span-2" hint="What the original shows (signer names, audit certificate, who scanned it). Signatures are never recreated.">
        <Textarea id="ar-notes" name="evidenceNotes" maxLength={4000} />
      </Field>
      <Field label="Who can see it" htmlFor="ar-vis" hint="Families see only their own documents.">
        <Select id="ar-vis" name="visibility" defaultValue="staff">
          <option value="staff">Staff only</option>
          <option value="subject_and_guardians">Staff, the person, and their guardians</option>
        </Select>
      </Field>
      <Field label="PDF file (max 15 MB)" htmlFor="ar-file" required error={fe.file}>
        <Input id="ar-file" name="file" type="file" accept="application/pdf,.pdf" required className="h-auto py-1.5" />
      </Field>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass("primary")}>
          {pending ? "Uploading…" : "Upload archive"}
        </button>
        {res?.error ? (
          <p role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
            {res.error}
          </p>
        ) : null}
        {res?.ok ? (
          <p role="status" className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
            {res.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

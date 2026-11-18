import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { trainingSettings } from "@/lib/training/common";
import { KG_PER_LB, METHOD_LABEL } from "@/lib/training/formulas";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { saveTrainingSettingsAction } from "../actions";

export const metadata = { title: "Training settings" };

export default async function TrainingSettingsPage() {
  const viewer = await requireCap("settings.manage");
  const s = await trainingSettings(db, viewer.orgId);
  return (
    <div>
      <PageHeader kicker="Training" title="Training settings" />
      <TrainingNav viewer={viewer} current="settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Plate rounding" />
          <CardBody>
            <ActionForm action={saveTrainingSettingsAction} className="grid grid-cols-2 gap-3">
              <Field label="lb increment" htmlFor="inc-lb" hint="Default 5 lb">
                <Input id="inc-lb" name="incrementLb" type="number" step="0.25" min={0.25} max={25} defaultValue={s.increment.lb} required />
              </Field>
              <Field label="kg increment" htmlFor="inc-kg" hint="Default 2.5 kg">
                <Input id="inc-kg" name="incrementKg" type="number" step="0.25" min={0.25} max={10} defaultValue={s.increment.kg} required />
              </Field>
              <div className="col-span-2">
                <SubmitButton>Save</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Methods (reference)" />
          <CardBody>
            <ul className="space-y-1 text-sm">
              {Object.entries(METHOD_LABEL).map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code> — {v}
                </li>
              ))}
              <li>
                Unit conversion is explicit only: 1 lb = {KG_PER_LB} kg. % loads are computed in the unit the max was recorded in.
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

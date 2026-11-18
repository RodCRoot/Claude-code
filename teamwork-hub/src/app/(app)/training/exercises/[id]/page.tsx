import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { listExercises } from "@/lib/training/exercises";
import { ButtonLink, Card, CardBody, PageHeader } from "@/components/ui";
import { TrainingNav } from "../../_components/training-nav";
import { ExerciseForm } from "../../_components/exercise-form";

export const metadata = { title: "Edit exercise" };

export default async function EditExercisePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireCap("training.manage");
  const all = await listExercises(db, viewer, { includeInactive: true });
  const ex = all.find((e) => e.id === id);
  if (!ex) notFound();
  return (
    <div>
      <PageHeader kicker="Exercise library" title={ex.name} actions={<ButtonLink href="/training/exercises" variant="secondary">Back to library</ButtonLink>} />
      <TrainingNav viewer={viewer} current="exercises" />
      <Card>
        <CardBody className="pt-5">
          <ExerciseForm exercise={ex} all={all} />
        </CardBody>
      </Card>
    </div>
  );
}

// Idempotent catalog sync, run at every production boot (start:deploy):
// upserts metric types and makes sure each org has the FMS protocol. Never
// touches athlete data — safe on live databases.
import { PrismaClient } from "@prisma/client";
import { METRIC_TYPES, FMS_KEYS } from "../prisma/catalog";

const prisma = new PrismaClient();

async function main() {
  for (const t of METRIC_TYPES) {
    await prisma.metricType.upsert({
      where: { key: t.key },
      create: t,
      update: { name: t.name, unit: t.unit, category: t.category, higherIsBetter: t.higherIsBetter, relativeToBw: t.relativeToBw, inComposite: (t as any).inComposite ?? true },
    });
  }
  const fmsIds = (await prisma.metricType.findMany({ where: { key: { in: FMS_KEYS } } }))
    .sort((a, b) => FMS_KEYS.indexOf(a.key) - FMS_KEYS.indexOf(b.key));
  const orgs = await prisma.organization.findMany({ include: { users: { where: { role: { in: ["ADMIN", "COACH"] } }, take: 1 } } });
  for (const org of orgs) {
    const existing = await prisma.evalProtocol.findFirst({ where: { orgId: org.id, name: "FMS Movement Screen" } });
    if (!existing && org.users[0] && fmsIds.length === FMS_KEYS.length) {
      await prisma.evalProtocol.create({
        data: {
          orgId: org.id, name: "FMS Movement Screen",
          description: "Functional Movement Screen — 7 tests scored 0-3 (total /21; <14 flags elevated injury risk)",
          createdById: org.users[0].id,
          items: { create: fmsIds.map((t, i) => ({ metricTypeId: t.id, order: i })) },
        },
      });
      console.log(`ensure-catalog: added FMS protocol for ${org.name}`);
    }
  }
  console.log(`ensure-catalog: ${METRIC_TYPES.length} metric types ensured.`);
}

main().finally(() => prisma.$disconnect());

import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !name || !password) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, and BOOTSTRAP_ADMIN_PASSWORD must be configured.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid email address.");
  }
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters and no more than 72 UTF-8 bytes.");
  }

  const user = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(702607112, 1)::text AS acquired`;
    if (await tx.user.count() !== 0) {
      throw new Error("Bootstrap is allowed only when the User table is empty.");
    }
    const created = await tx.user.create({
      data: { email, name, role: Role.SUPER_ADMIN, passwordHash: await bcrypt.hash(password, 12) },
      select: { id: true, email: true, role: true },
    });
    await tx.auditLog.create({
      data: { userId: created.id, action: "INITIAL_SUPER_ADMIN_CREATED", entity: "USER", entityId: created.id, success: true },
    });
    return created;
  });
  console.log(`Created initial ${user.role} account ${user.email}. No password was printed.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Super administrator bootstrap failed.");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

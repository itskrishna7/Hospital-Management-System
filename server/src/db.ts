import { PrismaClient } from "@prisma/client";
import { validateTestNeonTarget } from "./test-database-url.js";

if (process.env.NODE_ENV === "test") {
  const testTarget = validateTestNeonTarget({
    projectId: process.env.TEST_NEON_PROJECT_ID,
    branchId: process.env.TEST_NEON_BRANCH_ID,
    branchName: process.env.TEST_NEON_BRANCH_NAME,
    branchIsDefault: process.env.TEST_NEON_BRANCH_IS_DEFAULT,
    parentBranchId: process.env.TEST_NEON_PARENT_BRANCH_ID,
    parentBranchName: process.env.TEST_NEON_PARENT_BRANCH_NAME,
    databaseName: process.env.TEST_NEON_DATABASE_NAME,
    pooledHost: process.env.TEST_NEON_POOLED_HOST,
    directHost: process.env.TEST_NEON_DIRECT_HOST,
    pooledUrl: process.env.TEST_DATABASE_URL,
    directUrl: process.env.TEST_DATABASE_DIRECT_URL,
  });
  process.env.DATABASE_URL = testTarget.pooledUrl;
  process.env.DIRECT_URL = testTarget.directUrl;
}

export const prisma = new PrismaClient();

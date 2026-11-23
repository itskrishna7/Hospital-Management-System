import { describe, expect, it } from "vitest";
import { validateTestNeonTarget, type TestNeonTarget } from "./test-database-url.js";

const validTarget: TestNeonTarget = {
  projectId: "test-project",
  branchId: "br-mediverse-test-123",
  branchName: "mediverse-test-integration",
  branchIsDefault: "false",
  parentBranchId: "br-mediverse-test-seed-123",
  parentBranchName: "mediverse-test-seed-empty",
  databaseName: "mediverse_test",
  pooledHost: "ep-test-pooler.us-east-2.aws.neon.tech",
  directHost: "ep-test.us-east-2.aws.neon.tech",
  pooledUrl: "postgresql://test_role:test_password@ep-test-pooler.us-east-2.aws.neon.tech/mediverse_test?sslmode=require",
  directUrl: "postgresql://test_role:test_password@ep-test.us-east-2.aws.neon.tech/mediverse_test?sslmode=verify-full",
};

describe("test database URL safety", () => {
  it("accepts pooled and direct URLs pinned to a verified Neon test target", () => {
    expect(validateTestNeonTarget(validTarget)).toEqual({
      pooledUrl: validTarget.pooledUrl,
      directUrl: validTarget.directUrl,
    });
  });

  it("rejects missing branch identity before creating a client", () => {
    expect(() => validateTestNeonTarget({ ...validTarget, branchId: undefined }))
      .toThrow(/TEST_NEON_BRANCH_ID/);
  });

  it("rejects production or non-test branch names", () => {
    expect(() => validateTestNeonTarget({ ...validTarget, branchName: "production" }))
      .toThrow(/dedicated mediverse-test branch/);
  });

  it("rejects default branches and non-synthetic parent names", () => {
    expect(() => validateTestNeonTarget({ ...validTarget, branchIsDefault: "true" }))
      .toThrow(/dedicated mediverse-test branch/);
    expect(() => validateTestNeonTarget({ ...validTarget, parentBranchName: "production" }))
      .toThrow(/dedicated mediverse-test branch/);
  });

  it("rejects endpoint host mismatches", () => {
    expect(() => validateTestNeonTarget({
      ...validTarget,
      pooledUrl: "postgresql://test_role:test_password@ep-other-pooler.us-east-2.aws.neon.tech/mediverse_test?sslmode=require",
    })).toThrow(/verified Neon test branch/);
    expect(() => validateTestNeonTarget({
      ...validTarget,
      directUrl: "postgresql://test_role:test_password@ep-other.us-east-2.aws.neon.tech/mediverse_test?sslmode=require",
    })).toThrow(/verified Neon test branch/);
  });

  it.each([
    "postgresql://test_role:test_password@localhost/mediverse_test?sslmode=require",
    "postgresql://test_role:test_password@ep-test-pooler.us-east-2.aws.neon.tech/mediverse?sslmode=require",
    "postgresql://test_role:test_password@ep-test-pooler.us-east-2.aws.neon.tech/mediverse_test?host=other.neon.tech&sslmode=require",
    "postgresql://test_role:test_password@ep-test-pooler.us-east-2.aws.neon.tech/mediverse_test?sslmode=disable",
    "not-a-postgres-url",
  ])("rejects unsafe test database URL %s", (pooledUrl) => {
    expect(() => validateTestNeonTarget({ ...validTarget, pooledUrl }))
      .toThrow(/verified Neon test branch|valid PostgreSQL URLs/);
  });
});

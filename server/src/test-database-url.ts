const testDatabaseName = "mediverse_test";
const forbiddenConnectionOverrides = new Set(["host", "hostaddr", "service", "servicefile"]);

export interface TestNeonTarget {
  projectId: string | undefined;
  branchId: string | undefined;
  branchName: string | undefined;
  branchIsDefault: string | undefined;
  parentBranchId: string | undefined;
  parentBranchName: string | undefined;
  databaseName: string | undefined;
  pooledHost: string | undefined;
  directHost: string | undefined;
  pooledUrl: string | undefined;
  directUrl: string | undefined;
}

export interface ValidatedTestNeonTarget {
  pooledUrl: string;
  directUrl: string;
}

function requireValue(value: string | undefined, variable: string): string {
  if (!value?.trim()) {
    throw new Error(`${variable} must be set from the verified dedicated Neon test branch.`);
  }
  return value.trim();
}

function validateNeonUrl(
  value: string,
  expectedHost: string,
  expectedPooled: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Neon test connection URLs must be valid PostgreSQL URLs.");
  }

  const overridesRemoteHost = [...url.searchParams.keys()]
    .some((key) => forbiddenConnectionOverrides.has(key.toLowerCase()));
  const host = url.hostname.toLowerCase();
  const expected = expectedHost.toLowerCase();
  const endpointLabel = host.split(".")[0] ?? "";
  const isPooledHost = endpointLabel.endsWith("-pooler");
  const sslModes = url.searchParams.getAll("sslmode");
  const sslMode = sslModes[0]?.toLowerCase();

  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !host.endsWith(".neon.tech")
    || !endpointLabel.startsWith("ep-")
    || host !== expected
    || url.pathname !== `/${testDatabaseName}`
    || (url.port !== "" && url.port !== "5432")
    || !url.username
    || !url.password
    || sslModes.length !== 1
    || !["require", "verify-full"].includes(sslMode ?? "")
    || isPooledHost !== expectedPooled
    || overridesRemoteHost
  ) {
    throw new Error("Test URLs must match the verified Neon test branch, endpoint, database, and TLS settings.");
  }

  return value;
}

export function validateTestNeonTarget(target: TestNeonTarget): ValidatedTestNeonTarget {
  requireValue(target.projectId, "TEST_NEON_PROJECT_ID");
  const branchId = requireValue(target.branchId, "TEST_NEON_BRANCH_ID");
  const branchName = requireValue(target.branchName, "TEST_NEON_BRANCH_NAME");
  const branchIsDefault = requireValue(target.branchIsDefault, "TEST_NEON_BRANCH_IS_DEFAULT");
  const parentBranchId = requireValue(target.parentBranchId, "TEST_NEON_PARENT_BRANCH_ID");
  const parentBranchName = requireValue(target.parentBranchName, "TEST_NEON_PARENT_BRANCH_NAME");
  const databaseName = requireValue(target.databaseName, "TEST_NEON_DATABASE_NAME");
  const pooledHost = requireValue(target.pooledHost, "TEST_NEON_POOLED_HOST");
  const directHost = requireValue(target.directHost, "TEST_NEON_DIRECT_HOST");
  const pooledUrl = requireValue(target.pooledUrl, "TEST_DATABASE_URL");
  const directUrl = requireValue(target.directUrl, "TEST_DATABASE_DIRECT_URL");

  if (
    !/^br-[a-z0-9-]+$/i.test(branchId)
    || !/^mediverse-test-[a-z0-9][a-z0-9-]*$/i.test(branchName)
    || branchIsDefault !== "false"
    || !/^br-[a-z0-9-]+$/i.test(parentBranchId)
    || !/^mediverse-test-seed-[a-z0-9][a-z0-9-]*$/i.test(parentBranchName)
    || databaseName !== testDatabaseName
    || pooledHost.toLowerCase() === directHost.toLowerCase()
  ) {
    throw new Error("Test branch metadata must identify a dedicated mediverse-test branch and mediverse_test database.");
  }

  return {
    pooledUrl: validateNeonUrl(pooledUrl, pooledHost, true),
    directUrl: validateNeonUrl(directUrl, directHost, false),
  };
}

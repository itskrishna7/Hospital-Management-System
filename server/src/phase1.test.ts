import { describe, expect, it, vi } from "vitest";
import { isSafeOrigin, requireRole, hashToken } from "./auth.js";
import { createTotpCode, decryptMfaSecret, encryptMfaSecret, generateMfaSecret, verifyTotp } from "./mfa.js";

describe("Phase 1 security helpers", () => {
  it("allows safe reads and rejects mismatched production mutation origins", () => {
    expect(isSafeOrigin("GET", undefined, "production", "https://app.example.test")).toBe(true);
    expect(isSafeOrigin("POST", "https://app.example.test", "production", "https://app.example.test")).toBe(true);
    expect(isSafeOrigin("POST", "https://evil.example.test", "production", "https://app.example.test")).toBe(false);
    expect(isSafeOrigin("POST", undefined, "development", "http://localhost:5173")).toBe(true);
  });

  it("hashes opaque session tokens deterministically", () => {
    expect(hashToken("known-session-token")).toBe(hashToken("known-session-token"));
    expect(hashToken("known-session-token")).not.toBe("known-session-token");
  });

  it("allows only explicitly authorized roles", () => {
    const next = vi.fn();
    const forbiddenStatus = vi.fn(() => ({ json: vi.fn() }));
    const req = { auth: { userId: "user-1", role: "DOCTOR" } } as never;
    requireRole("ADMIN", "HOSPITAL_ADMIN")(req, { status: forbiddenStatus } as never, next);
    expect(forbiddenStatus).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    const allowedNext = vi.fn();
    const allowedReq = { auth: { userId: "doctor-1", role: "DOCTOR" } } as never;
    requireRole("DOCTOR")(allowedReq, {} as never, allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();
  });

  it("encrypts MFA secrets and validates TOTP codes", () => {
    const secret = generateMfaSecret();
    const encrypted = encryptMfaSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptMfaSecret(encrypted)).toBe(secret);
    const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(createTotpCode(rfcSecret, 59_000)).toBe("287082");
    const code = createTotpCode(secret, 1_700_000_000_000);
    expect(verifyTotp(secret, code, 1_700_000_000_000)).toBe(true);
    const wrongCode = code === "000000" ? "000001" : "000000";
    expect(verifyTotp(secret, wrongCode, 1_700_000_000_000)).toBe(false);
  });
});

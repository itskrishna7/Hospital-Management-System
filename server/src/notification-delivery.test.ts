import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    RESEND_API_KEY: undefined as string | undefined,
    RESEND_FROM: undefined as string | undefined,
  },
  apiKeys: [] as string[],
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };

    constructor(apiKey: string) {
      mocks.apiKeys.push(apiKey);
    }
  },
}));

vi.mock("./config/env.js", () => ({ env: mocks.env }));

import { DeliveryUnavailableError, sendPortalEmail } from "./notification-delivery.js";

describe("Resend email delivery", () => {
  beforeEach(() => {
    mocks.env.RESEND_API_KEY = "test-resend-api-key";
    mocks.env.RESEND_FROM = "MediVerse <notifications@example.test>";
    mocks.apiKeys.length = 0;
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ data: { id: "email-id" }, error: null });
  });

  it("uses configured credentials and sender with a request timeout", async () => {
    await sendPortalEmail("patient@example.test", "Portal update", "Sign in to view details.");

    expect(mocks.apiKeys).toEqual(["test-resend-api-key"]);
    expect(mocks.send).toHaveBeenCalledWith(
      {
        from: "MediVerse <notifications@example.test>",
        to: "patient@example.test",
        subject: "Portal update",
        text: "Sign in to view details.",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reports missing configuration without making a provider request", async () => {
    mocks.env.RESEND_API_KEY = undefined;

    await expect(sendPortalEmail("patient@example.test", "Portal update", "Sign in to view details."))
      .rejects.toBeInstanceOf(DeliveryUnavailableError);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("surfaces provider rejection without exposing its response message", async () => {
    mocks.send.mockResolvedValue({ data: null, error: { statusCode: 422, message: "provider response contains details" } });

    await expect(sendPortalEmail("patient@example.test", "Portal update", "Sign in to view details."))
      .rejects.toThrow(/^Email provider rejected the request \(HTTP 422\)\.$/);
  });
});

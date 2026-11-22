import { Resend } from "resend";
import { env } from "./config/env.js";

export class DeliveryUnavailableError extends Error {
  constructor(channel: "email") {
    super(`${channel} delivery is not configured.`);
    this.name = "DeliveryUnavailableError";
  }
}

export async function sendPortalEmail(to: string, subject: string, text: string) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    throw new DeliveryUnavailableError("email");
  }
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send(
    { from: env.RESEND_FROM, to, subject, text },
    { signal: AbortSignal.timeout(10_000) },
  );
  if (error) {
    const status = error.statusCode ? ` (HTTP ${error.statusCode})` : "";
    throw new Error(`Email provider rejected the request${status}.`);
  }
}

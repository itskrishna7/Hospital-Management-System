import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  CLIENT_ORIGIN: z.string().url().refine((value) => new URL(value).origin === value, "CLIENT_ORIGIN must be an origin without a path.").default("http://localhost:5173"),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SESSION_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
});
export const env = schema.parse(process.env);

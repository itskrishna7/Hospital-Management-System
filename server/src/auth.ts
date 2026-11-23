import crypto from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "./db.js";
import { env } from "./config/env.js";

export const SESSION_COOKIE = "mediverse_session";
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export type AuthenticatedRequest = Request & {
  auth?: {
    userId: string;
    role: Role;
  };
};

export function getClientIp(req: Request) {
  if (process.env.VERCEL === "1") {
    const vercelClientIp = req.header("x-vercel-forwarded-for")?.trim();
    if (vercelClientIp && isIP(vercelClientIp)) return vercelClientIp;
  }
  return req.socket.remoteAddress ?? null;
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getSessionToken(req: Request) {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = match?.slice(SESSION_COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  const secure = env.NODE_ENV === "production";
  res.appendHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`);
}

export function clearSessionCookie(res: Response) {
  const secure = env.NODE_ENV === "production";
  res.appendHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`);
}

export function auditLogData(req: Request, input: {
  action: string;
  entity: string;
  entityId?: string;
  success?: boolean;
  metadata?: object;
}) {
  const auth = (req as AuthenticatedRequest).auth;
  return {
    userId: auth?.userId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    method: req.method,
    route: req.path,
    ipAddress: getClientIp(req),
    userAgent: req.header("user-agent")?.slice(0, 500),
    correlationId: req.header("x-correlation-id")?.slice(0, 100),
    success: input.success ?? true,
    metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : undefined,
  };
}

export async function writeAudit(req: Request, input: Parameters<typeof auditLogData>[1]) {
  await prisma.auditLog.create({ data: auditLogData(req, input) });
}

export function isSafeOrigin(method: string, origin: string | undefined, runtimeEnvironment: string, clientOrigin: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  return runtimeEnvironment !== "production" || origin === clientOrigin;
}

export function requireSafeOrigin(req: Request, res: Response, next: NextFunction) {
  if (!isSafeOrigin(req.method, req.header("origin"), env.NODE_ENV, env.CLIENT_ORIGIN)) {
    return res.status(403).json({ error: { code: "CSRF_ORIGIN_MISMATCH", message: "The request origin is not allowed." } });
  }
  next();
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const token = getSessionToken(req);
    if (!token) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        mfaVerified: true,
        user: { select: { active: true, role: true } },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active) {
      return res.status(401).json({ error: { code: "SESSION_INVALID", message: "The session is invalid or expired." } });
    }
    if (!session.mfaVerified) return res.status(401).json({ error: { code: "MFA_REQUIRED", message: "Complete multi-factor verification to continue." } });
    req.auth = { userId: session.userId, role: session.user.role };
    next();
  } catch {
    next(new Error("Unable to validate session."));
  }
}

export async function requireMfaChallenge(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const token = getSessionToken(req);
    if (!token) return res.status(401).json({ error: { code: "MFA_CHALLENGE_REQUIRED", message: "Complete multi-factor verification." } });
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        mfaVerified: true,
        user: { select: { active: true, mfaEnabled: true, role: true } },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.active || !session.user.mfaEnabled || session.mfaVerified) {
      return res.status(401).json({ error: { code: "MFA_CHALLENGE_INVALID", message: "The multi-factor challenge is invalid or expired." } });
    }
    req.auth = { userId: session.userId, role: session.user.role };
    next();
  } catch {
    next(new Error("Unable to validate multi-factor challenge."));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission for this operation." } });
    }
    next();
  };
}

export async function checkLoginRateLimit(email: string, ipAddress: string | null) {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const byEmail = await prisma.loginHistory.count({
    where: { email: email.toLowerCase(), successful: false, failureReason: { in: ["INVALID_CREDENTIALS", "MFA_INVALID"] }, createdAt: { gte: since } },
  });
  if (byEmail >= 5) return true;
  if (!ipAddress) return false;
  const byIp = await prisma.loginHistory.count({
    where: { ipAddress, successful: false, failureReason: { in: ["INVALID_CREDENTIALS", "MFA_INVALID"] }, createdAt: { gte: since } },
  });
  return byIp >= 20;
}

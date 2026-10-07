import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../config/env';
import { randomToken, sha256 } from './password';
import { prisma } from './prisma';

export const REFRESH_COOKIE = 'dd_refresh';

export interface AccessTokenPayload {
  sub: string;
  kind: 'STAFF' | 'CLIENT';
  /** Client id, present only for CLIENT users; used for portal scoping. */
  cid?: string;
  /** Short hash of the permission set so the SPA can cache-bust on change. */
  v: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'digital-dude-crm',
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'digital-dude-crm',
  }) as AccessTokenPayload;
}

/**
 * Issues a refresh token, stores only its hash, and returns the plaintext for
 * the cookie. Rotation happens on every refresh, with the old row revoked.
 */
export async function issueRefreshToken(opts: {
  userId: string;
  userAgent?: string;
  ip?: string;
  replacesId?: string;
}): Promise<string> {
  const plain = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const created = await prisma.refreshToken.create({
    data: {
      userId: opts.userId,
      tokenHash: sha256(plain),
      userAgent: opts.userAgent?.slice(0, 255),
      ip: opts.ip,
      expiresAt,
    },
  });

  if (opts.replacesId) {
    await prisma.refreshToken.update({
      where: { id: opts.replacesId },
      data: { revokedAt: new Date(), replacedBy: created.id },
    });
  }

  return plain;
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    // 'lax' is enough: the SPA is on a different host but refresh is a POST we
    // trigger ourselves, and CSRF cannot read the response cross-origin.
    sameSite: env.isProd ? 'none' : 'lax',
    domain: env.isProd ? env.COOKIE_DOMAIN : undefined,
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

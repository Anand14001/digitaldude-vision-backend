import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import {
  hashPassword,
  randomToken,
  sha256,
  validatePasswordStrength,
  verifyPassword,
} from '../../lib/password';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  issueRefreshToken,
  setRefreshCookie,
  signAccessToken,
} from '../../lib/tokens';
import { badRequest, forbidden, unauthorized } from '../../lib/errors';
import { recordAudit } from '../../lib/audit';
import { layout, sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import {
  ALL_PERMISSIONS,
  BASELINE_STAFF_PERMISSIONS,
  expandPermissions,
} from '../../permissions/registry';

const requestMeta = (req: Request) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

/** The session payload the SPA bootstraps from. */
async function sessionPayload(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      kind: true,
      phone: true,
      theme: true,
      status: true,
      mustChangePassword: true,
      avatar: { select: { url: true } },
      role: { select: { id: true, name: true, isAdmin: true, permissions: true } },
      employee: {
        select: {
          id: true,
          employeeCode: true,
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
      },
      clientContact: {
        select: {
          id: true,
          canApprove: true,
          client: { select: { id: true, name: true, logo: { select: { url: true } } } },
        },
      },
      permissionGrants: { select: { permission: true, allow: true } },
    },
  });

  let permissions: string[] = [];
  if (user.kind === 'STAFF') {
    if (user.role?.isAdmin) {
      permissions = ALL_PERMISSIONS;
    } else {
      const set = expandPermissions([
        ...BASELINE_STAFF_PERMISSIONS,
        ...(user.role?.permissions ?? []),
      ]);
      for (const g of user.permissionGrants) {
        if (g.allow) for (const k of expandPermissions([g.permission])) set.add(k);
      }
      for (const g of user.permissionGrants) if (!g.allow) set.delete(g.permission);
      permissions = [...set];
    }
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      kind: user.kind,
      phone: user.phone,
      theme: user.theme,
      avatarUrl: user.avatar?.url ?? null,
      mustChangePassword: user.mustChangePassword,
      role: user.role ? { id: user.role.id, name: user.role.name, isAdmin: user.role.isAdmin } : null,
      employee: user.employee
        ? {
            id: user.employee.id,
            code: user.employee.employeeCode,
            designation: user.employee.designation?.title ?? null,
            department: user.employee.department?.name ?? null,
          }
        : null,
      client: user.clientContact
        ? {
            id: user.clientContact.client.id,
            name: user.clientContact.client.name,
            logoUrl: user.clientContact.client.logo?.url ?? null,
            canApprove: user.clientContact.canApprove,
          }
        : null,
    },
    permissions,
  };
}

export async function login(req: Request, res: Response, input: { email: string; password: string }) {
  const meta = requestMeta(req);
  const user = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase(), deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      kind: true,
      status: true,
      passwordHash: true,
      clientContact: { select: { portalEnabled: true } },
    },
  });

  // One generic failure message for every reason, so the endpoint cannot be
  // used to discover which email addresses exist.
  const fail = async (reason: string) => {
    await recordAudit({
      actor: { id: user?.id ?? null, label: input.email, ...meta },
      action: 'LOGIN_FAILED',
      entityType: 'User',
      entityId: user?.id ?? null,
      summary: `Failed sign-in for ${input.email} (${reason})`,
    });
    throw unauthorized('Incorrect email or password');
  };

  if (!user || !user.passwordHash) return fail('no such account');
  if (!(await verifyPassword(input.password, user.passwordHash))) return fail('bad password');
  if (user.status === 'SUSPENDED') return fail('suspended');
  if (user.status === 'INVITED') return fail('invite not accepted');
  if (user.kind === 'CLIENT' && !user.clientContact?.portalEnabled) {
    return fail('portal disabled');
  }

  const refresh = await issueRefreshToken({ userId: user.id, ...meta });
  setRefreshCookie(res, refresh);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await recordAudit({
    actor: { id: user.id, label: `${user.name} <${user.email}>`, ...meta },
    action: 'LOGIN',
    entityType: 'User',
    entityId: user.id,
    summary: `${user.name} signed in`,
  });

  const payload = await sessionPayload(user.id);
  return {
    accessToken: signAccessToken({ sub: user.id, kind: user.kind, v: 1 }),
    ...payload,
  };
}

/** Rotates the refresh token and mints a new access token. */
export async function refresh(req: Request, res: Response) {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!presented) throw unauthorized('No session');

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(presented) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: { kind: true, status: true, deletedAt: true } },
    },
  });

  if (!stored || stored.user.deletedAt) {
    clearRefreshCookie(res);
    throw unauthorized('Session not recognised');
  }

  if (stored.revokedAt) {
    // A revoked token being replayed means the cookie leaked: kill every
    // session for that user rather than just refusing this one request.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    clearRefreshCookie(res);
    throw unauthorized('Session reuse detected, please sign in again');
  }

  if (stored.expiresAt < new Date()) {
    clearRefreshCookie(res);
    throw unauthorized('Session expired');
  }

  if (stored.user.status !== 'ACTIVE') {
    clearRefreshCookie(res);
    throw forbidden('This account is not active');
  }

  const rotated = await issueRefreshToken({
    userId: stored.userId,
    replacesId: stored.id,
    ...requestMeta(req),
  });
  setRefreshCookie(res, rotated);

  const payload = await sessionPayload(stored.userId);
  return {
    accessToken: signAccessToken({ sub: stored.userId, kind: stored.user.kind, v: 1 }),
    ...payload,
  };
}

export async function logout(req: Request, res: Response) {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (presented) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearRefreshCookie(res);
  if (req.auth) {
    await recordAudit({
      actor: {
        id: req.auth.user.id,
        label: `${req.auth.user.name} <${req.auth.user.email}>`,
        ...requestMeta(req),
      },
      action: 'LOGOUT',
      entityType: 'User',
      entityId: req.auth.user.id,
      summary: `${req.auth.user.name} signed out`,
    });
  }
}

export const me = (userId: string) => sessionPayload(userId);

export async function changePassword(
  req: Request,
  input: { currentPassword: string; newPassword: string },
) {
  const userId = req.ctx.user.id;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user.passwordHash || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw badRequest('Your current password is incorrect');
  }
  const problems = validatePasswordStrength(input.newPassword);
  if (problems.length) throw badRequest(`Password ${problems.join(', ')}`);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        mustChangePassword: false,
      },
    });
    // Changing a password ends every other session.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAudit(
      {
        actor: {
          id: userId,
          label: `${req.ctx.user.name} <${req.ctx.user.email}>`,
          ...requestMeta(req),
        },
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        summary: 'Changed their own password',
      },
      tx,
    );
  });
}

export async function forgotPassword(req: Request, email: string) {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null, status: 'ACTIVE' },
    select: { id: true, name: true, email: true },
  });

  // Always report success: the response must not reveal whether an account exists.
  if (!user) return;

  const token = randomToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken: token, resetExpiresAt: new Date(Date.now() + 60 * 60_000) },
  });

  const url = `${env.webOrigins[0] ?? ''}/reset-password?token=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your Vision password',
    html: layout({
      heading: 'Reset your password',
      body: `<p>Hi ${user.name.split(' ')[0] ?? 'there'},</p><p>Use the button below to set a new password. This link expires in one hour. If you did not request it, you can ignore this email.</p>`,
      ctaLabel: 'Set a new password',
      ctaUrl: url,
    }),
  });
}

export async function resetPassword(
  req: Request,
  input: { token: string; newPassword: string },
) {
  const user = await prisma.user.findFirst({
    where: { resetToken: input.token, resetExpiresAt: { gt: new Date() }, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw badRequest('This reset link is invalid or has expired');

  const problems = validatePasswordStrength(input.newPassword);
  if (problems.length) throw badRequest(`Password ${problems.join(', ')}`);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        resetToken: null,
        resetExpiresAt: null,
        mustChangePassword: false,
      },
    });
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAudit(
      {
        actor: { id: user.id, label: `${user.name} <${user.email}>`, ...requestMeta(req) },
        action: 'UPDATE',
        entityType: 'User',
        entityId: user.id,
        summary: 'Reset their password via email link',
      },
      tx,
    );
  });
}

/** Turns an invite into an active account by setting the first password. */
export async function acceptInvite(
  req: Request,
  res: Response,
  input: { token: string; password: string },
) {
  const user = await prisma.user.findFirst({
    where: { inviteToken: input.token, inviteExpiresAt: { gt: new Date() }, deletedAt: null },
    select: { id: true, name: true, email: true, kind: true, status: true },
  });
  if (!user) throw badRequest('This invitation is invalid or has expired');
  if (user.status === 'SUSPENDED') throw forbidden('This account has been suspended');

  const problems = validatePasswordStrength(input.password);
  if (problems.length) throw badRequest(`Password ${problems.join(', ')}`);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.password),
      status: 'ACTIVE',
      inviteToken: null,
      inviteExpiresAt: null,
      mustChangePassword: false,
      lastLoginAt: new Date(),
    },
  });

  await recordAudit({
    actor: { id: user.id, label: `${user.name} <${user.email}>`, ...requestMeta(req) },
    action: 'UPDATE',
    entityType: 'User',
    entityId: user.id,
    summary: `${user.name} accepted their invitation`,
  });

  const refreshToken = await issueRefreshToken({ userId: user.id, ...requestMeta(req) });
  setRefreshCookie(res, refreshToken);

  const payload = await sessionPayload(user.id);
  return {
    accessToken: signAccessToken({ sub: user.id, kind: user.kind, v: 1 }),
    ...payload,
  };
}

export async function updatePreferences(
  userId: string,
  input: { theme?: 'LIGHT' | 'DARK' | 'SYSTEM'; name?: string; phone?: string },
) {
  await prisma.user.update({ where: { id: userId }, data: input });
  return sessionPayload(userId);
}

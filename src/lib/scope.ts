import type { Prisma } from '@prisma/client';
import { forbidden } from './errors';
import type { AuthContext } from '../types/express';

/**
 * Every list query runs its where-clause through one of these builders, so
 * "who can see this row" is decided in one place rather than in each handler.
 *
 * The rule throughout: a `.all` permission returns an unrestricted filter, a
 * `.assigned`/`.team`/`.own` permission returns a narrowed one, and no relevant
 * permission throws. Client-portal callers never reach these - they go through
 * portalClientId() and are pinned to their own account.
 */

/** The client account a portal user is locked to; throws for anyone else. */
export function portalClientId(ctx: AuthContext): string {
  if (ctx.user.kind !== 'CLIENT' || !ctx.clientId) {
    throw forbidden('Client portal access only');
  }
  return ctx.clientId;
}

export function projectWhere(ctx: AuthContext): Prisma.ProjectWhereInput {
  if (ctx.user.kind === 'CLIENT') {
    return {
      kind: 'CLIENT',
      clientId: portalClientId(ctx),
      visibleToClient: true,
      deletedAt: null,
    };
  }
  if (ctx.has('projects.view.all')) return { deletedAt: null };
  if (ctx.has('projects.view.assigned')) {
    const employeeId = ctx.employeeId ?? '__none__';
    return {
      deletedAt: null,
      OR: [{ managerId: employeeId }, { members: { some: { employeeId } } }],
    };
  }
  throw forbidden('You do not have access to projects');
}

export function retainerWhere(ctx: AuthContext): Prisma.RetainerWhereInput {
  if (ctx.user.kind === 'CLIENT') {
    return { clientId: portalClientId(ctx), deletedAt: null };
  }
  if (ctx.has('retainers.view.all')) return { deletedAt: null };
  if (ctx.has('retainers.view.assigned')) {
    return { deletedAt: null, managerId: ctx.employeeId ?? '__none__' };
  }
  throw forbidden('You do not have access to retainers');
}

export function clientWhere(ctx: AuthContext): Prisma.ClientWhereInput {
  if (ctx.user.kind === 'CLIENT') return { id: portalClientId(ctx), deletedAt: null };
  if (ctx.has('clients.view.all')) return { deletedAt: null };
  if (ctx.has('clients.view.assigned')) {
    const employeeId = ctx.employeeId ?? '__none__';
    return {
      deletedAt: null,
      OR: [
        { accountManagerId: employeeId },
        { projects: { some: { members: { some: { employeeId } } } } },
      ],
    };
  }
  throw forbidden('You do not have access to clients');
}

export function leadWhere(ctx: AuthContext): Prisma.LeadWhereInput {
  if (ctx.has('leads.view.all')) return { deletedAt: null };
  if (ctx.has('leads.view.own')) {
    return { deletedAt: null, ownerId: ctx.employeeId ?? '__none__' };
  }
  throw forbidden('You do not have access to leads');
}

export function taskWhere(ctx: AuthContext): Prisma.TaskWhereInput {
  if (ctx.user.kind === 'CLIENT') {
    const clientId = portalClientId(ctx);
    return {
      deletedAt: null,
      visibleToClient: true,
      OR: [
        { project: { clientId, visibleToClient: true } },
        { retainerCycle: { retainer: { clientId } } },
      ],
    };
  }
  if (ctx.has('tasks.view.all')) return { deletedAt: null };
  if (ctx.has('tasks.view.assigned')) {
    const employeeId = ctx.employeeId ?? '__none__';
    return {
      deletedAt: null,
      OR: [
        { assigneeId: employeeId },
        { project: { OR: [{ managerId: employeeId }, { members: { some: { employeeId } } }] } },
      ],
    };
  }
  throw forbidden('You do not have access to tasks');
}

/** Employee visibility: everyone, direct reports (plus self), or self only. */
export function employeeWhere(ctx: AuthContext): Prisma.EmployeeWhereInput {
  if (ctx.has('employees.view.all')) return {};
  const employeeId = ctx.employeeId ?? '__none__';
  if (ctx.has('employees.view.team')) {
    return { OR: [{ id: employeeId }, { reportingToId: employeeId }] };
  }
  return { id: employeeId };
}

/**
 * Shared shape for the HR modules (time, attendance, leave, performance), which
 * all answer the same question: mine, my team's, or everyone's.
 */
export function hrSubjectWhere(
  ctx: AuthContext,
  perms: { all: string; team: string },
): { employeeId?: string; employee?: Prisma.EmployeeWhereInput } {
  if (ctx.has(perms.all)) return {};
  const employeeId = ctx.employeeId ?? '__none__';
  if (ctx.has(perms.team)) {
    return { employee: { OR: [{ id: employeeId }, { reportingToId: employeeId }] } };
  }
  return { employeeId };
}

/** True when the caller may act on this specific employee's HR records. */
export function canActOnEmployee(
  ctx: AuthContext,
  target: { id: string; reportingToId: string | null },
  perms: { all: string; team: string },
): boolean {
  if (ctx.has(perms.all)) return true;
  if (target.id === ctx.employeeId) return true;
  return ctx.has(perms.team) && target.reportingToId === ctx.employeeId;
}

/** Strips fields the caller is not cleared to see from an employee payload. */
export function redactEmployee<T extends Record<string, unknown>>(
  ctx: AuthContext,
  employee: T,
): T {
  const out = { ...employee } as Record<string, unknown>;
  const isSelf = employee.id === ctx.employeeId;

  if (!ctx.has('employees.pii.view') && !isSelf) {
    for (const field of [
      'dateOfBirth',
      'personalEmail',
      'personalPhone',
      'emergencyContact',
      'emergencyPhone',
      'bloodGroup',
      'addressLine',
      'city',
      'state',
      'pincode',
    ]) {
      delete out[field];
    }
  }
  if (!ctx.has('employees.compensation.view')) delete out.compensation;
  return out as T;
}

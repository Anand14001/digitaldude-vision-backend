import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake, orderByFrom } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { clientWhere } from '../../lib/scope';
import { randomToken } from '../../lib/password';
import { layout, sendMail } from '../../lib/mailer';
import { env } from '../../config/env';

export const clientsRouter = Router();

const SORTABLE = ['name', 'createdAt', 'status', 'onboardedAt'] as const;

const clientBody = z.object({
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().max(200).optional(),
  status: z.enum(['PROSPECT', 'ACTIVE', 'PAUSED', 'CHURNED']).default('ACTIVE'),
  industry: z.string().trim().max(80).optional(),
  website: z.string().trim().url().max(200).optional().or(z.literal('')),
  gstin: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  addressLine: z.string().trim().max(250).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).default('India'),
  pincode: z.string().trim().max(12).optional(),
  accountManagerId: z.string().cuid().nullish(),
  onboardedAt: z.coerce.date().nullish(),
  notes: z.string().trim().max(4000).optional(),
  serviceLineIds: z.array(z.string().cuid()).max(20).default([]),
});

const listQuery = paginationSchema.extend({
  status: z.enum(['PROSPECT', 'ACTIVE', 'PAUSED', 'CHURNED']).optional(),
  accountManagerId: z.string().cuid().optional(),
  serviceLineId: z.string().cuid().optional(),
});

// ------------------------------------------------------------------- listing
clientsRouter.get(
  '/',
  requirePermission('clients.view.all', 'clients.view.assigned'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...clientWhere(req.ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.accountManagerId ? { accountManagerId: q.accountManagerId } : {}),
      ...(q.serviceLineId ? { serviceLines: { some: { serviceLineId: q.serviceLineId } } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { legalName: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
              { city: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.client.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'name'),
        select: {
          id: true,
          name: true,
          status: true,
          industry: true,
          city: true,
          phone: true,
          email: true,
          createdAt: true,
          logo: { select: { url: true } },
          accountManager: {
            select: { id: true, user: { select: { name: true } } },
          },
          serviceLines: { select: { serviceLine: { select: { id: true, name: true } } } },
          _count: { select: { projects: true, retainers: true, contacts: true } },
        },
        ...skipTake(q),
      }),
      prisma.client.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

// ---------------------------------------------------------------- single read
clientsRouter.get(
  '/:id',
  requirePermission('clients.view.all', 'clients.view.assigned'),
  asyncHandler(async (req, res) => {
    const client = await prisma.client.findFirst({
      where: { AND: [clientWhere(req.ctx), { id: req.params.id }] },
      include: {
        logo: { select: { url: true } },
        accountManager: {
          select: { id: true, employeeCode: true, user: { select: { name: true, email: true } } },
        },
        serviceLines: { include: { serviceLine: true } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
        projects: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            health: true,
            dueDate: true,
            currentStage: { select: { name: true, color: true } },
          },
        },
        retainers: {
          where: { deletedAt: null },
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            billingCycle: true,
            amountPerCycle: true,
            endDate: true,
          },
        },
      },
    });
    if (!client) throw notFound('Client');

    // Budget figures are a separate clearance from merely seeing the account.
    if (!req.ctx.has('reports.financial.view')) {
      client.retainers = client.retainers.map((r) => ({ ...r, amountPerCycle: null }));
    }

    return ok(res, client);
  }),
);

// -------------------------------------------------------------------- create
clientsRouter.post(
  '/',
  requirePermission('clients.create'),
  validateBody(clientBody),
  asyncHandler(async (req, res) => {
    const { serviceLineIds, ...data } = req.body as z.infer<typeof clientBody>;

    const client = await prisma.client.create({
      data: {
        ...data,
        website: data.website || null,
        email: data.email || null,
        serviceLines: { create: serviceLineIds.map((serviceLineId) => ({ serviceLineId })) },
      },
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Client',
      entityId: client.id,
      entityLabel: client.name,
      summary: `Created client "${client.name}"`,
      diff: diffRecords(null, data as Record<string, unknown>) ?? undefined,
    });

    return created(res, client);
  }),
);

// -------------------------------------------------------------------- update
clientsRouter.patch(
  '/:id',
  requirePermission('clients.update'),
  validateBody(clientBody.partial()),
  asyncHandler(async (req, res) => {
    const before = await prisma.client.findFirst({
      where: { AND: [clientWhere(req.ctx), { id: req.params.id }] },
    });
    if (!before) throw notFound('Client');

    const { serviceLineIds, ...data } = req.body as Partial<z.infer<typeof clientBody>>;

    const client = await prisma.$transaction(async (tx) => {
      if (serviceLineIds) {
        await tx.clientServiceLine.deleteMany({ where: { clientId: before.id } });
        if (serviceLineIds.length) {
          await tx.clientServiceLine.createMany({
            data: serviceLineIds.map((serviceLineId) => ({
              clientId: before.id,
              serviceLineId,
            })),
          });
        }
      }
      return tx.client.update({
        where: { id: before.id },
        data: {
          ...data,
          ...(data.status === 'CHURNED' && before.status !== 'CHURNED'
            ? { churnedAt: new Date() }
            : {}),
        },
      });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Client',
      entityId: client.id,
      entityLabel: client.name,
      summary: `Updated client "${client.name}"`,
      diff: diffRecords(before, data as Record<string, unknown>) ?? undefined,
    });

    return ok(res, client);
  }),
);

// ----------------------------------------------------------------- soft delete
clientsRouter.delete(
  '/:id',
  requirePermission('clients.delete'),
  asyncHandler(async (req, res) => {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        _count: {
          select: {
            projects: { where: { deletedAt: null, status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] } } },
            retainers: { where: { deletedAt: null, status: 'ACTIVE' } },
          },
        },
      },
    });
    if (!client) throw notFound('Client');
    if (client._count.projects || client._count.retainers) {
      throw conflict('Close or reassign this client’s live projects and retainers first');
    }

    // Soft delete: history, invoices and the audit trail must survive.
    await prisma.client.update({
      where: { id: client.id },
      data: { deletedAt: new Date(), status: 'CHURNED' },
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Client',
      entityId: client.id,
      entityLabel: client.name,
      summary: `Archived client "${client.name}"`,
    });

    return noContent(res);
  }),
);

// ------------------------------------------------------------------- contacts
const contactBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(30).optional(),
  designation: z.string().trim().max(80).optional(),
  isPrimary: z.boolean().default(false),
});

clientsRouter.post(
  '/:id/contacts',
  requirePermission('clients.contacts.manage'),
  validateBody(contactBody),
  asyncHandler(async (req, res) => {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!client) throw notFound('Client');

    const contact = await prisma.$transaction(async (tx) => {
      if (req.body.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId: client.id },
          data: { isPrimary: false },
        });
      }
      return tx.clientContact.create({ data: { ...req.body, clientId: client.id } });
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'ClientContact',
      entityId: contact.id,
      entityLabel: contact.name,
      summary: `Added contact ${contact.name} to ${client.name}`,
    });

    return created(res, contact);
  }),
);

clientsRouter.patch(
  '/contacts/:contactId',
  requirePermission('clients.contacts.manage'),
  validateBody(contactBody.partial()),
  asyncHandler(async (req, res) => {
    const before = await prisma.clientContact.findUnique({
      where: { id: req.params.contactId },
      include: { client: { select: { name: true } } },
    });
    if (!before) throw notFound('Contact');

    const contact = await prisma.$transaction(async (tx) => {
      if (req.body.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId: before.clientId, id: { not: before.id } },
          data: { isPrimary: false },
        });
      }
      return tx.clientContact.update({ where: { id: before.id }, data: req.body });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'ClientContact',
      entityId: contact.id,
      entityLabel: contact.name,
      summary: `Updated contact ${contact.name} at ${before.client.name}`,
      diff: diffRecords(before, req.body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, contact);
  }),
);

clientsRouter.delete(
  '/contacts/:contactId',
  requirePermission('clients.contacts.manage'),
  asyncHandler(async (req, res) => {
    const contact = await prisma.clientContact.findUnique({
      where: { id: req.params.contactId },
      select: { id: true, name: true, userId: true, client: { select: { name: true } } },
    });
    if (!contact) throw notFound('Contact');

    await prisma.$transaction(async (tx) => {
      await tx.clientContact.delete({ where: { id: contact.id } });
      // Removing the contact also removes their ability to sign in.
      if (contact.userId) {
        await tx.user.update({
          where: { id: contact.userId },
          data: { status: 'SUSPENDED', deletedAt: new Date() },
        });
        await tx.refreshToken.updateMany({
          where: { userId: contact.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'ClientContact',
      entityId: contact.id,
      entityLabel: contact.name,
      summary: `Removed contact ${contact.name} from ${contact.client.name}`,
    });

    return noContent(res);
  }),
);

// -------------------------------------------------------------- portal access
/**
 * Grants a contact portal access. This mints a CLIENT user - never a staff user
 * with a role - so portal accounts can never pick up staff permissions.
 */
clientsRouter.post(
  '/contacts/:contactId/portal-access',
  requirePermission('clients.portal.manage'),
  validateBody(z.object({ canApprove: z.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const contact = await prisma.clientContact.findUnique({
      where: { id: req.params.contactId },
      include: { client: { select: { id: true, name: true, deletedAt: true } } },
    });
    if (!contact) throw notFound('Contact');
    if (contact.client.deletedAt) throw badRequest('This client is archived');

    const clash = await prisma.user.findFirst({
      where: { email: contact.email, deletedAt: null, kind: 'STAFF' },
      select: { id: true },
    });
    if (clash) {
      throw conflict('That email already belongs to a staff account');
    }

    const token = randomToken();
    const result = await prisma.$transaction(async (tx) => {
      let userId = contact.userId;
      if (userId) {
        await tx.user.update({
          where: { id: userId },
          data: {
            status: 'INVITED',
            deletedAt: null,
            inviteToken: token,
            inviteExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        });
      } else {
        const user = await tx.user.create({
          data: {
            kind: 'CLIENT',
            email: contact.email,
            name: contact.name,
            status: 'INVITED',
            inviteToken: token,
            inviteExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        });
        userId = user.id;
      }
      return tx.clientContact.update({
        where: { id: contact.id },
        data: { userId, portalEnabled: true, canApprove: req.body.canApprove },
      });
    });

    await sendMail({
      to: contact.email,
      subject: `${contact.client.name} - your Digital Dude project portal`,
      html: layout({
        heading: 'Your project portal is ready',
        body: `<p>Hi ${contact.name.split(' ')[0] ?? 'there'},</p><p>We have set up a portal where you can follow progress on your projects${req.body.canApprove ? ' and approve deliverables' : ''}. Set a password to sign in.</p>`,
        ctaLabel: 'Set your password',
        ctaUrl: `${env.webOrigins[0] ?? ''}/portal/accept-invite?token=${token}`,
      }),
    });

    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'ClientContact',
      entityId: contact.id,
      entityLabel: contact.name,
      summary: `Granted portal access to ${contact.name} (${contact.client.name})`,
      diff: { portalEnabled: { from: contact.portalEnabled, to: true } },
    });

    return created(res, result);
  }),
);

clientsRouter.delete(
  '/contacts/:contactId/portal-access',
  requirePermission('clients.portal.manage'),
  asyncHandler(async (req, res) => {
    const contact = await prisma.clientContact.findUnique({
      where: { id: req.params.contactId },
      select: { id: true, name: true, userId: true, portalEnabled: true },
    });
    if (!contact) throw notFound('Contact');
    if (!contact.portalEnabled) throw badRequest('This contact does not have portal access');

    await prisma.$transaction(async (tx) => {
      await tx.clientContact.update({
        where: { id: contact.id },
        data: { portalEnabled: false, canApprove: false },
      });
      if (contact.userId) {
        await tx.refreshToken.updateMany({
          where: { userId: contact.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'ClientContact',
      entityId: contact.id,
      entityLabel: contact.name,
      summary: `Revoked portal access for ${contact.name}`,
      diff: { portalEnabled: { from: true, to: false } },
    });

    return noContent(res);
  }),
);

/** Lightweight option list for pickers; avoids pulling the full client payload. */
clientsRouter.get(
  '/options/all',
  requirePermission('clients.view.all', 'clients.view.assigned'),
  asyncHandler(async (req, res) => {
    if (req.ctx.user.kind === 'CLIENT') throw forbidden();
    const clients = await prisma.client.findMany({
      where: { ...clientWhere(req.ctx), status: { not: 'CHURNED' } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, status: true },
      take: 500,
    });
    return ok(res, clients);
  }),
);

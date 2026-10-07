import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requireAuth, requireClient } from '../../middleware/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { portalClientId } from '../../lib/scope';
import { recordAudit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { dayjs } from '../../lib/dates';

export const portalRouter = Router();

/**
 * Every route here is pinned to the caller's own client account by
 * portalClientId(), which throws for anyone who is not a portal user. Nothing
 * in this module reads a staff permission, and nothing exposes internal fields:
 * budgets, cost, staff utilisation and internal comments never appear.
 */
portalRouter.use(requireAuth, requireClient);

// ------------------------------------------------------------------- overview
portalRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);

    const [client, projects, retainers, awaitingApproval, recentDeliverables] =
      await Promise.all([
        prisma.client.findUniqueOrThrow({
          where: { id: clientId },
          select: {
            id: true,
            name: true,
            logo: { select: { url: true } },
            accountManager: {
              select: {
                user: { select: { name: true, email: true, phone: true, avatar: { select: { url: true } } } },
                designation: { select: { title: true } },
              },
            },
          },
        }),
        prisma.project.findMany({
          where: { clientId, visibleToClient: true, deletedAt: null },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            startDate: true,
            dueDate: true,
            completedAt: true,
            currentStage: { select: { id: true, name: true, color: true, sortOrder: true } },
            workflow: {
              select: { stages: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, color: true } } },
            },
          },
        }),
        prisma.retainer.findMany({
          where: { clientId, deletedAt: null, status: { not: 'ENDED' } },
          select: {
            id: true,
            name: true,
            status: true,
            billingCycle: true,
            cycles: {
              orderBy: { periodStart: 'desc' },
              take: 1,
              select: { id: true, label: true, status: true, periodStart: true, periodEnd: true },
            },
          },
        }),
        prisma.deliverable.count({
          where: {
            status: 'CLIENT_REVIEW',
            OR: [
              { project: { clientId, visibleToClient: true } },
              { retainerCycle: { retainer: { clientId } } },
            ],
          },
        }),
        prisma.deliverable.findMany({
          where: {
            status: { in: ['CLIENT_REVIEW', 'APPROVED', 'PUBLISHED'] },
            OR: [
              { project: { clientId, visibleToClient: true } },
              { retainerCycle: { retainer: { clientId } } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 6,
          select: {
            id: true,
            title: true,
            status: true,
            dueDate: true,
            updatedAt: true,
            project: { select: { id: true, name: true } },
          },
        }),
      ]);

    return ok(res, {
      client,
      canApprove: req.ctx.canApprove,
      summary: {
        activeProjects: projects.filter((p) => p.status === 'ACTIVE' || p.status === 'PLANNING')
          .length,
        completedProjects: projects.filter((p) => p.status === 'COMPLETED').length,
        activeRetainers: retainers.filter((r) => r.status === 'ACTIVE').length,
        awaitingYourApproval: awaitingApproval,
      },
      projects,
      retainers,
      recentDeliverables,
    });
  }),
);

// ------------------------------------------------------------------- projects
portalRouter.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, clientId, visibleToClient: true, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        dueDate: true,
        completedAt: true,
        currentStage: { select: { id: true, name: true, color: true, sortOrder: true } },
        workflow: {
          select: {
            stages: {
              orderBy: { sortOrder: 'asc' },
              select: { id: true, name: true, color: true, sortOrder: true, isTerminal: true },
            },
          },
        },
        manager: {
          select: {
            user: { select: { name: true, email: true, avatar: { select: { url: true } } } },
          },
        },
        milestones: {
          orderBy: { dueDate: 'asc' },
          select: { id: true, title: true, dueDate: true, completedAt: true, description: true },
        },
        // Only tasks explicitly marked client-visible.
        tasks: {
          where: { visibleToClient: true, deletedAt: null },
          orderBy: [{ dueDate: 'asc' }],
          select: {
            id: true,
            title: true,
            dueDate: true,
            completedAt: true,
            status: { select: { name: true, color: true, category: true } },
          },
        },
        deliverables: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            status: true,
            dueDate: true,
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
              select: {
                id: true,
                versionNumber: true,
                notes: true,
                createdAt: true,
                files: {
                  where: { deletedAt: null },
                  select: { id: true, originalName: true, url: true, mimeType: true, sizeBytes: true },
                },
              },
            },
          },
        },
        stageHistory: {
          orderBy: { enteredAt: 'desc' },
          select: { enteredAt: true, stage: { select: { name: true, color: true } } },
        },
      },
    });
    if (!project) throw notFound('Project');

    // Progress is derived from stage position, which is what clients ask about.
    const stages = project.workflow.stages;
    const currentIndex = stages.findIndex((s) => s.id === project.currentStage?.id);
    const progressPercent =
      project.status === 'COMPLETED'
        ? 100
        : stages.length
          ? Math.round(((currentIndex + 1) / stages.length) * 100)
          : 0;

    return ok(res, { ...project, progressPercent });
  }),
);

// ------------------------------------------------------- deliverable approvals
portalRouter.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);

    const deliverables = await prisma.deliverable.findMany({
      where: {
        status: { in: ['CLIENT_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED'] },
        OR: [
          { project: { clientId, visibleToClient: true } },
          { retainerCycle: { retainer: { clientId } } },
        ],
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        dueDate: true,
        approvedAt: true,
        project: { select: { id: true, code: true, name: true } },
        retainerCycle: {
          select: { id: true, label: true, retainer: { select: { name: true } } },
        },
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: {
            id: true,
            versionNumber: true,
            notes: true,
            createdAt: true,
            files: {
              where: { deletedAt: null },
              select: { id: true, originalName: true, url: true, mimeType: true, sizeBytes: true },
            },
          },
        },
        approvals: {
          where: { stage: 'CLIENT' },
          orderBy: { requestedAt: 'desc' },
          select: {
            id: true,
            decision: true,
            comment: true,
            requestedAt: true,
            decidedAt: true,
            decidedBy: { select: { name: true } },
          },
        },
      },
    });

    return ok(res, deliverables);
  }),
);

/** The approval decision itself - only a contact flagged canApprove may do this. */
portalRouter.post(
  '/approvals/:id/decision',
  validateBody(
    z.object({
      decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
      comment: z.string().trim().max(2000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);
    if (!req.ctx.canApprove) {
      throw forbidden('Your account can view deliverables but not approve them');
    }

    const deliverable = await prisma.deliverable.findFirst({
      where: {
        id: req.params.id,
        OR: [
          { project: { clientId, visibleToClient: true } },
          { retainerCycle: { retainer: { clientId } } },
        ],
      },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        approvals: { where: { stage: 'CLIENT', decision: 'PENDING' }, take: 1 },
        project: { select: { id: true, name: true, managerId: true } },
        retainerCycle: { select: { retainer: { select: { name: true, managerId: true } } } },
      },
    });
    if (!deliverable) throw notFound('Deliverable');
    if (deliverable.status !== 'CLIENT_REVIEW') {
      throw badRequest('This deliverable is not currently awaiting your approval');
    }

    const pending = deliverable.approvals[0];
    const version = deliverable.versions[0];
    const approved = req.body.decision === 'APPROVED';
    if (!approved && !req.body.comment) {
      throw badRequest('Please tell us what needs changing');
    }

    await prisma.$transaction(async (tx) => {
      if (pending) {
        await tx.approval.update({
          where: { id: pending.id },
          data: {
            decision: req.body.decision,
            decidedById: req.ctx.user.id,
            decidedAt: new Date(),
            comment: req.body.comment ?? null,
          },
        });
      } else {
        await tx.approval.create({
          data: {
            deliverableId: deliverable.id,
            versionId: version?.id ?? null,
            stage: 'CLIENT',
            decision: req.body.decision,
            decidedById: req.ctx.user.id,
            decidedAt: new Date(),
            comment: req.body.comment ?? null,
          },
        });
      }

      await tx.deliverable.update({
        where: { id: deliverable.id },
        data: {
          status: approved ? 'APPROVED' : 'CHANGES_REQUESTED',
          approvedAt: approved ? new Date() : null,
        },
      });

      // The client's words belong on the record, visible to the team.
      if (req.body.comment) {
        await tx.comment.create({
          data: {
            entityType: 'DELIVERABLE',
            entityId: deliverable.id,
            authorId: req.ctx.user.id,
            body: req.body.comment,
            isInternal: false,
          },
        });
      }
    });

    await recordAudit({
      actor: {
        id: req.ctx.user.id,
        label: `${req.ctx.user.name} <${req.ctx.user.email}> (client)`,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      },
      action: approved ? 'APPROVE' : 'REJECT',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Client ${approved ? 'approved' : 'requested changes on'} "${deliverable.title}"`,
    });

    // Tell the people responsible for the work.
    const managerEmployeeId =
      deliverable.project?.managerId ?? deliverable.retainerCycle?.retainer.managerId ?? null;
    const recipients = new Set<string>();
    if (managerEmployeeId) {
      const manager = await prisma.employee.findUnique({
        where: { id: managerEmployeeId },
        select: { userId: true },
      });
      if (manager) recipients.add(manager.userId);
    }
    if (deliverable.project) {
      const members = await prisma.projectMember.findMany({
        where: { projectId: deliverable.project.id },
        select: { employee: { select: { userId: true } } },
      });
      members.forEach((m) => recipients.add(m.employee.userId));
    }

    await notify({
      userIds: [...recipients],
      type: 'APPROVAL_DECIDED',
      title: `${approved ? 'Approved' : 'Changes requested'}: ${deliverable.title}`,
      body: req.body.comment,
      link: `/deliverables/${deliverable.id}`,
      entityType: 'Deliverable',
      entityId: deliverable.id,
      email: true,
    });

    return ok(res, { decision: req.body.decision });
  }),
);

// ----------------------------------------------------------------------- files
portalRouter.get(
  '/files',
  validate({ query: z.object({ projectId: z.string().cuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);
    const q = req.query as unknown as { projectId?: string };

    if (q.projectId) {
      const allowed = await prisma.project.count({
        where: { id: q.projectId, clientId, visibleToClient: true, deletedAt: null },
      });
      if (!allowed) throw notFound('Project');
    }

    const files = await prisma.fileObject.findMany({
      where: {
        deletedAt: null,
        OR: [
          { clientId },
          ...(q.projectId
            ? [{ projectId: q.projectId }]
            : [{ project: { clientId, visibleToClient: true } }]),
          {
            deliverableVersion: {
              deliverable: {
                // Only files from deliverables that have reached the client.
                status: { in: ['CLIENT_REVIEW', 'APPROVED', 'PUBLISHED'] },
                OR: [
                  { project: { clientId, visibleToClient: true } },
                  { retainerCycle: { retainer: { clientId } } },
                ],
              },
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalName: true,
        url: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
      },
      take: 300,
    });

    return ok(res, files);
  }),
);

// -------------------------------------------------------------------- contacts
portalRouter.get(
  '/team',
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);

    const [contacts, projectTeam] = await Promise.all([
      prisma.clientContact.findMany({
        where: { clientId },
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          designation: true,
          isPrimary: true,
          portalEnabled: true,
        },
      }),
      prisma.projectMember.findMany({
        where: {
          project: { clientId, visibleToClient: true, deletedAt: null, status: { in: ['PLANNING', 'ACTIVE'] } },
        },
        select: {
          isLead: true,
          roles: { select: { role: { select: { name: true, sortOrder: true } } } },
          employee: {
            select: {
              id: true,
              user: { select: { name: true, avatar: { select: { url: true } } } },
              designation: { select: { title: true } },
            },
          },
        },
      }),
    ]);

    // De-duplicate: one person may sit on several of the client's projects.
    const seen = new Set<string>();
    const agencyTeam = projectTeam
      .filter((m) => {
        if (seen.has(m.employee.id)) return false;
        seen.add(m.employee.id);
        return true;
      })
      .map((m) => ({
        name: m.employee.user.name,
        avatarUrl: m.employee.user.avatar?.url ?? null,
        designation: m.employee.designation?.title ?? null,
        isLead: m.isLead,
        roles: m.roles
          .sort((a, b) => a.role.sortOrder - b.role.sortOrder)
          .map((entry) => entry.role.name),
      }));

    return ok(res, { contacts, agencyTeam });
  }),
);

// -------------------------------------------------------------------- activity
portalRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);
    const since = dayjs().subtract(90, 'day').toDate();

    const [stageMoves, deliverables] = await Promise.all([
      prisma.projectStageHistory.findMany({
        where: {
          enteredAt: { gte: since },
          project: { clientId, visibleToClient: true, deletedAt: null },
        },
        orderBy: { enteredAt: 'desc' },
        take: 40,
        select: {
          id: true,
          enteredAt: true,
          stage: { select: { name: true, color: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      prisma.deliverable.findMany({
        where: {
          updatedAt: { gte: since },
          status: { in: ['CLIENT_REVIEW', 'APPROVED', 'PUBLISHED', 'CHANGES_REQUESTED'] },
          OR: [
            { project: { clientId, visibleToClient: true } },
            { retainerCycle: { retainer: { clientId } } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 40,
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          project: { select: { id: true, name: true } },
        },
      }),
    ]);

    const items = [
      ...stageMoves.map((s) => ({
        type: 'stage' as const,
        id: s.id,
        at: s.enteredAt,
        title: `${s.project.name} moved to ${s.stage.name}`,
        projectId: s.project.id,
      })),
      ...deliverables.map((d) => ({
        type: 'deliverable' as const,
        id: d.id,
        at: d.updatedAt,
        title: `${d.title} - ${d.status.toLowerCase().replace('_', ' ')}`,
        projectId: d.project?.id ?? null,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    return ok(res, items.slice(0, 50));
  }),
);

/** Clients may raise a note against a project, which becomes a visible comment. */
portalRouter.post(
  '/projects/:id/messages',
  validateBody(z.object({ body: z.string().trim().min(2).max(4000) })),
  asyncHandler(async (req, res) => {
    const clientId = portalClientId(req.ctx);
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, clientId, visibleToClient: true, deletedAt: null },
      select: { id: true, name: true, managerId: true },
    });
    if (!project) throw notFound('Project');

    const comment = await prisma.comment.create({
      data: {
        entityType: 'PROJECT',
        entityId: project.id,
        authorId: req.ctx.user.id,
        body: req.body.body,
        isInternal: false,
      },
    });

    const recipients = new Set<string>();
    if (project.managerId) {
      const manager = await prisma.employee.findUnique({
        where: { id: project.managerId },
        select: { userId: true },
      });
      if (manager) recipients.add(manager.userId);
    }
    const members = await prisma.projectMember.findMany({
      where: { projectId: project.id },
      select: { employee: { select: { userId: true } } },
    });
    members.forEach((m) => recipients.add(m.employee.userId));

    await notify({
      userIds: [...recipients],
      type: 'COMMENT_REPLY',
      title: `Client message on ${project.name}`,
      body: req.body.body.slice(0, 160),
      link: `/projects/${project.id}`,
      entityType: 'Project',
      entityId: project.id,
      email: true,
    });

    return created(res, comment);
  }),
);

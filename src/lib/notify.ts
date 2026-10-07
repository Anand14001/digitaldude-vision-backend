import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { layout, sendMail } from './mailer';

export interface NotifyInput {
  userIds: string[];
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Also send an email, not just the in-app bell. */
  email?: boolean;
}

/**
 * Creates in-app notifications and optionally emails them. Swallows its own
 * failures so a notification problem never breaks the triggering request.
 */
export async function notify(
  input: NotifyInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (!userIds.length) return;

  try {
    await tx.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      })),
    });

    if (!input.email) return;

    const users = await tx.user.findMany({
      where: { id: { in: userIds }, status: 'ACTIVE', deletedAt: null },
      select: { id: true, email: true, name: true },
    });

    await Promise.all(
      users.map((u) =>
        sendMail({
          to: u.email,
          subject: input.title,
          html: layout({
            heading: input.title,
            body: `<p>Hi ${u.name.split(' ')[0] ?? 'there'},</p><p>${input.body ?? ''}</p>`,
            ctaLabel: input.link ? 'Open in CRM' : undefined,
            ctaUrl: input.link ? `${process.env.WEB_APP_URL ?? ''}${input.link}` : undefined,
          }),
        }),
      ),
    );
  } catch (error) {
    logger.error({ error, type: input.type }, 'failed to deliver notification');
  }
}

import { Router } from 'express';
import { requireAuth, requireStaff, blockIfPasswordChangeRequired } from '../middleware/auth';
import { authRouter } from '../modules/auth/auth.routes';
import { portalRouter } from '../modules/portal/portal.routes';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes';
import { clientsRouter } from '../modules/clients/clients.routes';
import { leadsRouter } from '../modules/leads/leads.routes';
import { projectsRouter } from '../modules/projects/projects.routes';
import { retainersRouter } from '../modules/retainers/retainers.routes';
import { tasksRouter } from '../modules/tasks/tasks.routes';
import { workflowsRouter } from '../modules/workflows/workflows.routes';
import { deliverablesRouter } from '../modules/deliverables/deliverables.routes';
import { employeesRouter } from '../modules/employees/employees.routes';
import { timeRouter } from '../modules/time/time.routes';
import { attendanceRouter } from '../modules/attendance/attendance.routes';
import { leaveRouter } from '../modules/leave/leave.routes';
import { performanceRouter } from '../modules/performance/performance.routes';
import { calendarRouter } from '../modules/calendar/calendar.routes';
import { commentsRouter } from '../modules/comments/comments.routes';
import { filesRouter } from '../modules/files/files.routes';
import { notificationsRouter } from '../modules/notifications/notifications.routes';
import { reportsRouter } from '../modules/reports/reports.routes';
import { logsRouter } from '../modules/logs/logs.routes';
import { rolesRouter } from '../modules/roles/roles.routes';
import { usersRouter } from '../modules/users/users.routes';
import { mastersRouter } from '../modules/masters/masters.routes';
import { settingsRouter } from '../modules/settings/settings.routes';

export const apiRouter = Router();

// Open: sign-in, invites, password resets.
apiRouter.use('/auth', authRouter);

// Client portal: authenticated, but deliberately NOT behind requireStaff.
apiRouter.use('/portal', portalRouter);

// Shared by both kinds of user.
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/comments', commentsRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/settings', settingsRouter);

/**
 * Everything below is staff-only and blocked while a forced password change is
 * outstanding, so one guard pair covers the whole internal surface rather than
 * each router having to remember it.
 */
const staff = Router();
staff.use(requireAuth, requireStaff, blockIfPasswordChangeRequired);

staff.use('/dashboard', dashboardRouter);
staff.use('/clients', clientsRouter);
staff.use('/leads', leadsRouter);
staff.use('/projects', projectsRouter);
staff.use('/retainers', retainersRouter);
staff.use('/tasks', tasksRouter);
staff.use('/workflows', workflowsRouter);
staff.use('/deliverables', deliverablesRouter);
staff.use('/employees', employeesRouter);
staff.use('/time', timeRouter);
staff.use('/attendance', attendanceRouter);
staff.use('/leave', leaveRouter);
staff.use('/performance', performanceRouter);
staff.use('/calendar', calendarRouter);
staff.use('/reports', reportsRouter);
staff.use('/logs', logsRouter);
staff.use('/roles', rolesRouter);
staff.use('/users', usersRouter);
staff.use('/masters', mastersRouter);

apiRouter.use(staff);

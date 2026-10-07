import type { UserKind, UserStatus } from '@prisma/client';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  kind: UserKind;
  status: UserStatus;
  roleId: string | null;
  roleName: string | null;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface AuthContext {
  user: AuthUser;
  /** Fully expanded permission set, including baseline and implied keys. */
  permissions: Set<string>;
  /** Present for staff users who have an employee record. */
  employeeId: string | null;
  /** Present only for CLIENT users - the account whose data they may see. */
  clientId: string | null;
  /** Client contacts may view without being allowed to approve. */
  canApprove: boolean;
  has: (permission: string) => boolean;
  hasAny: (...permissions: string[]) => boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Set by requireAuth; use when a route is known to be authenticated. */
      ctx: AuthContext;
    }
  }
}

export {};

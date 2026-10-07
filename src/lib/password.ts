import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const ROUNDS = 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);

export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** Opaque token for invites and password resets. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Refresh tokens are stored hashed so a database leak cannot replay sessions. */
export const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

/** Password policy, enforced on every place a password is set. */
export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('must be at least 10 characters');
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a number');
  return problems;
}

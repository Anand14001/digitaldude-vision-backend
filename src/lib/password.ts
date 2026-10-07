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

/**
 * Password policy, enforced everywhere a password is set.
 *
 * Length does more for strength than character-class rules, so this asks for a
 * reasonable length plus a letter and a number, and deliberately does not
 * require an uppercase letter. Raise it here if the agency ever wants stricter
 * rules - every path that sets a password goes through this one function.
 */
export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('must be at least 10 characters');
  if (!/[a-zA-Z]/.test(password)) problems.push('must contain a letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a number');
  return problems;
}

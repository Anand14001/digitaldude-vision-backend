import { z } from 'zod';

export const emailField = z.string().trim().toLowerCase().email('Enter a valid email address');
const passwordField = z.string().min(1, 'Password is required').max(200);

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
});

export const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
});

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z.object({
  token: z.string().min(16),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(16),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

export const preferencesSchema = z.object({
  theme: z.enum(['LIGHT', 'DARK', 'SYSTEM']).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional(),
});

import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export interface MailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/**
 * Sends mail when SMTP is configured; otherwise logs it. Never throws - a
 * failed notification must not roll back the action that triggered it.
 */
export async function sendMail(input: MailInput): Promise<boolean> {
  const transport = getTransport();
  if (!transport) {
    logger.info({ to: input.to, subject: input.subject }, 'email (no SMTP configured)');
    return false;
  }
  try {
    await transport.sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? input.html.replace(/<[^>]+>/g, ' '),
    });
    return true;
  } catch (error) {
    logger.error({ error, to: input.to }, 'failed to send email');
    return false;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Shared shell so every transactional email looks the same. */
export function layout(opts: {
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<p style="margin:28px 0"><a href="${opts.ctaUrl}" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(opts.ctaLabel)}</a></p>`
      : '';
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-weight:700;font-size:18px;color:#4f46e5;margin-bottom:20px">Digital Dude CRM</div>
    <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 14px;font-size:19px;color:#0f172a">${escapeHtml(opts.heading)}</h1>
      <div style="font-size:14px;line-height:1.65;color:#334155">${opts.body}</div>
      ${cta}
    </div>
    <p style="color:#94a3b8;font-size:12px;margin-top:20px">You are receiving this because you have an account on the Digital Dude CRM.</p>
  </div></body></html>`;
}

import { env } from './env.ts'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

/**
 * Outbound email over SMTP (works with any provider — Resend, Postmark, SES,
 * a local relay). Entirely optional: with SMTP_HOST unset, emails are printed
 * to the server log instead, so verification and password-reset links remain
 * usable in development and small self-hosts without an email provider.
 */

export const mailerConfigured = !!env.SMTP_HOST

let transport: Transporter | null = null
if (mailerConfigured) {
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    /* 465 = implicit TLS; anything else negotiates STARTTLS */
    secure: env.SMTP_SECURE || env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
}

export async function sendMail(opts: { to: string; subject: string; text: string }) {
  if (!transport) {
    console.log(
      `[mail] SMTP not configured — logging instead\n  to: ${opts.to}\n  subject: ${opts.subject}\n  ${opts.text.replace(/\n/g, '\n  ')}`,
    )
    return
  }
  await transport.sendMail({
    from: env.EMAIL_FROM,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  })
}

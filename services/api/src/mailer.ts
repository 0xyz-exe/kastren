import process from 'node:process';
import nodemailer from 'nodemailer';

export function createMailAdapter(webOrigin: string): ((email: string, token: string) => Promise<void>) | undefined {
  const from = process.env.EMAIL_FROM ?? 'Kastren <noreply@kastren.app>';

  if (process.env.RESEND_API_KEY) {
    const apiKey = process.env.RESEND_API_KEY;
    return async (email: string, token: string) => {
      const resetUrl = `${webOrigin}/#reset-password?token=${encodeURIComponent(token)}`;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: email,
          subject: 'Reset your Kastren password',
          html: `<p>You requested a password reset for your Kastren account.</p><p><a href="${resetUrl}">Click here to reset your password</a> or use token:</p><p><code>${token}</code></p><p>This token expires in 1 hour.</p>`
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Resend email delivery failed (${res.status}): ${text}`);
      }
    };
  }

  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      } : undefined
    });

    return async (email: string, token: string) => {
      const resetUrl = `${webOrigin}/#reset-password?token=${encodeURIComponent(token)}`;
      await transporter.sendMail({
        from,
        to: email,
        subject: 'Reset your Kastren password',
        text: `Reset your Kastren password by visiting: ${resetUrl}\nOr use token: ${token}\n(Expires in 1 hour)`,
        html: `<p>You requested a password reset for your Kastren account.</p><p><a href="${resetUrl}">Click here to reset your password</a> or use token:</p><p><code>${token}</code></p><p>This token expires in 1 hour.</p>`
      });
    };
  }

  return undefined;
}

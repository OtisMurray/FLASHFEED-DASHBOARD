import nodemailer from 'nodemailer'

// Gmail SMTP sender for 2FA codes. Degrades quietly (like the Redis client
// elsewhere in this codebase) if credentials aren't configured — auth still
// works end-to-end once GMAIL_USER / GMAIL_APP_PASSWORD are set on Railway.
const GMAIL_USER = process.env.GMAIL_USER || ''
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || ''

let transporter = null
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  })
} else {
  console.warn('  Mailer  →  disabled (GMAIL_USER / GMAIL_APP_PASSWORD not set) — 2FA emails will fail until configured')
}

export const mailerReady = () => !!transporter

export async function sendTwoFactorCodeEmail(toEmail, code) {
  if (!transporter) throw new Error('Email is not configured on the server yet (GMAIL_APP_PASSWORD missing).')
  await transporter.sendMail({
    from: `FlashFeed <${GMAIL_USER}>`,
    to: toEmail,
    subject: `Your FlashFeed login code: ${code}`,
    text: `Your FlashFeed verification code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<div style="font-family:sans-serif">
      <p>Your FlashFeed verification code is:</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
      <p style="color:#666">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>`,
  })
}

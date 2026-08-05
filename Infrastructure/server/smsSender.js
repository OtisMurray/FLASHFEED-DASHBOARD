import twilio from 'twilio'

// Twilio SMS sender — same "degrade quietly until configured" pattern as
// mailer.js. Needs TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
// on Railway before SMS 2FA or stock alerts will actually send.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || ''
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || ''

let client = null
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
} else {
  console.warn('  SMS     →  disabled (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER not set) — SMS 2FA and stock alerts will fail until configured')
}

export const smsReady = () => !!client

export async function sendSms(toE164, body) {
  if (!client) throw new Error('SMS is not configured on the server yet (Twilio credentials missing).')
  await client.messages.create({ from: TWILIO_FROM_NUMBER, to: toE164, body })
}

export async function sendTwoFactorCodeSms(toE164, code) {
  await sendSms(toE164, `Your FlashFeed verification code is ${code}. It expires in 10 minutes.`)
}

export async function sendStockAlertSms(toE164, ticker, message) {
  await sendSms(toE164, `FlashFeed $${ticker}: ${message}`)
}

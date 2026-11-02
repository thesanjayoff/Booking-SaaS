/**
 * Channel adapters. Each is a tiny object with `configured()` and `send()`, so channels can be
 * swapped (or faked in tests) without touching scheduling or de-duplication logic.
 *
 *  - email    : SMTP via nodemailer; with no SMTP_HOST it writes to data/outbox/ so dev works offline
 *  - sms      : Twilio Programmable Messaging REST API
 *  - whatsapp : Meta WhatsApp Cloud API (template messages: required for business-initiated sends)
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env, has } from "../env";

export type Channel = "email" | "sms" | "whatsapp";

export type Outgoing = {
  to: string;
  subject?: string;
  text: string;
  html?: string;
  ics?: string;
  waParams?: string[];
};

export type Adapter = {
  channel: Channel;
  configured(): boolean;
  send(m: Outgoing): Promise<{ providerId?: string }>;
};

/** The provider rejected the message for good (bad number, auth error): retrying cannot help. */
export class PermanentSendError extends Error {}

const sanitizeHeader = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 300);

let transport: Transporter | null = null;
function smtp(): Transporter {
  if (transport) return transport;
  const e = env();
  transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: has(e.SMTP_USER) ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return transport;
}

export const emailAdapter: Adapter = {
  channel: "email",
  configured: () => true,
  async send(m) {
    const e = env();
    const subject = sanitizeHeader(m.subject ?? "");
    if (!has(e.SMTP_HOST)) {
      const dir = path.resolve("data/outbox");
      fs.mkdirSync(dir, { recursive: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ to: m.to, subject, text: m.text, hasIcs: !!m.ics }, null, 2));
      return { providerId: `outbox:${id}` };
    }
    const info = await smtp().sendMail({
      from: e.MAIL_FROM,
      to: m.to,
      subject,
      text: m.text,
      html: m.html,
      icalEvent: m.ics ? { method: "PUBLISH", content: m.ics } : undefined,
    });
    return { providerId: info.messageId };
  },
};

async function postJson(url: string, init: RequestInit, label: string) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  if (res.ok) return body;
  const msg = `${label} HTTP ${res.status}: ${body.slice(0, 200)}`;
  // 4xx (except 408/429) is the provider saying "this request is wrong", not "try later".
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new PermanentSendError(msg);
  throw new Error(msg);
}

export const smsAdapter: Adapter = {
  channel: "sms",
  configured: () => has(env().TWILIO_ACCOUNT_SID) && has(env().TWILIO_AUTH_TOKEN) && has(env().TWILIO_SMS_FROM),
  async send(m) {
    const e = env();
    const body = await postJson(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(e.TWILIO_ACCOUNT_SID!)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: m.to, From: e.TWILIO_SMS_FROM!, Body: m.text.slice(0, 600) }),
      },
      "Twilio",
    );
    return { providerId: (JSON.parse(body) as { sid?: string }).sid };
  },
};

export const whatsappAdapter: Adapter = {
  channel: "whatsapp",
  configured: () => has(env().WHATSAPP_PHONE_NUMBER_ID) && has(env().WHATSAPP_ACCESS_TOKEN),
  async send(m) {
    const e = env();
    const body = await postJson(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(e.WHATSAPP_PHONE_NUMBER_ID!)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: m.to.replace(/^\+/, ""),
          type: "template",
          // Template body, e.g.: "Hi {{1}}, reminder: your {{2}} is at {{3}} on {{4}}."
          template: {
            name: e.WHATSAPP_TEMPLATE_NAME,
            language: { code: "en" },
            components: [{ type: "body", parameters: (m.waParams ?? []).map((text) => ({ type: "text", text })) }],
          },
        }),
      },
      "WhatsApp",
    );
    return { providerId: (JSON.parse(body) as { messages?: { id: string }[] }).messages?.[0]?.id };
  },
};

const defaults: Record<Channel, Adapter> = { email: emailAdapter, sms: smsAdapter, whatsapp: whatsappAdapter };
const overrides: Partial<Record<Channel, Adapter>> = {};

export const getAdapter = (c: Channel): Adapter => overrides[c] ?? defaults[c];
/** Test hook. Pass undefined to restore the real adapter. */
export function setAdapter(c: Channel, a: Adapter | undefined) {
  if (a) overrides[c] = a;
  else delete overrides[c];
}

/** "+91 98765-43210" -> "+919876543210". Without a leading + we cannot know the country, so return null. */
export function toE164(raw: string, defaultCountryCode?: string): string | null {
  const s = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9][0-9]{6,14}$/.test(s)) return s;
  if (defaultCountryCode && /^0?[0-9]{7,12}$/.test(s)) return `+${defaultCountryCode}${s.replace(/^0/, "")}`;
  return null;
}

#!/usr/bin/env node
/* global process, console, fetch, AbortSignal -- Node built-ins; the lint config gives .mjs files no Node globals */
// Checks a Meta WhatsApp token by sending one approved template message, using
// the same request builder as the product (@app/whatsapp's messageBody).
//
//   node --env-file=.env scripts/whatsapp-smoke.mjs <to> [template] [language]
//   e.g. node --env-file=.env scripts/whatsapp-smoke.mjs 919800000000 hello_world en_US
//
// Reads WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_VERSION
// from the environment. Prints the HTTP status and Meta's response; the token
// never appears in the output. Needs `pnpm build:packages` once (for dist/).
import { messageBody } from '../packages/whatsapp/dist/index.js';

const [to, template = 'hello_world', language = 'en_US'] = process.argv.slice(2);
const token = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const version = process.env.WHATSAPP_API_VERSION || 'v26.0';

const missing = [
  ['recipient (first argument, digits only)', /^\d{8,15}$/.test(to ?? '')],
  ['WHATSAPP_ACCESS_TOKEN', token.length > 20],
  ['WHATSAPP_PHONE_NUMBER_ID', /^\d+$/.test(phoneNumberId)],
  ['WHATSAPP_API_VERSION (like v26.0)', /^v\d+\.\d+$/.test(version)],
].filter(([, ok]) => !ok);
if (missing.length > 0) {
  console.error(`Missing or invalid: ${missing.map(([name]) => name).join(', ')}`);
  process.exit(2);
}

const hide = (text) => text.split(token).join('<token hidden>');
const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
const body = messageBody(
  { phone: to },
  { kind: 'template', name: template, languageCode: language },
);

console.log(`POST ${url}`);
console.log(`template ${template} (${language}) to ${to.slice(0, 4)}…${to.slice(-3)}`);
const response = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(15_000),
});
const text = await response.text();
console.log(`HTTP ${response.status}`);
try {
  console.log(hide(JSON.stringify(JSON.parse(text), null, 2)));
} catch {
  console.log(hide(text));
}
process.exit(response.ok ? 0 : 1);

/**
 * The customer's side of WhatsApp, for local use and the public demo.
 * Deliberately not styled like WhatsApp (no green, no bubbles): this is a
 * test phone, and the brief forbids looking like an official WhatsApp product.
 */
export function simulatorPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Customer phone · WhatsApp simulator</title>
<style>
  :root { --thermal:#f3f5f4; --sheet:#fff; --ink:#18202e; --graphite:#5b6573; --ballpoint:#1f45b5; --stamp:#c21f32; --rule:#d5dade; --rule-strong:#7d8693; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--thermal); color:var(--ink); font:14px/1.45 system-ui, sans-serif; }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; }
  header { display:flex; gap:12px; align-items:baseline; padding:12px 16px; border-bottom:1px solid var(--rule); background:var(--sheet); }
  header h1 { font-size:16px; margin:0; }
  main { display:grid; grid-template-columns: 260px minmax(0, 420px) 280px; gap:16px; padding:16px; justify-content:center; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  section { background:var(--sheet); border:1px solid var(--rule); border-radius:4px; }
  h2 { font-size:12px; margin:0; padding:10px 12px; border-bottom:1px solid var(--rule); }
  .customers button { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--rule); padding:8px 12px; cursor:pointer; font:inherit; color:inherit; }
  .customers button[aria-pressed="true"] { box-shadow: inset 4px 0 0 var(--ink); background:var(--thermal); }
  .phone { display:flex; flex-direction:column; height: min(720px, 80vh); }
  .thread { flex:1; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:85%; padding:6px 10px; border:1px solid var(--rule); border-radius:4px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .msg.in { align-self:flex-end; border-color:var(--ink); }
  .msg.out { align-self:flex-start; background:var(--thermal); }
  .msg .meta { display:block; color:var(--graphite); margin-top:2px; }
  .msg.failed .meta { color:var(--stamp); }
  form { display:flex; flex-wrap:wrap; gap:8px; padding:8px; border-top:1px solid var(--rule); }
  input[type=text] { flex:1 1 100%; padding:8px; border:1px solid var(--rule-strong); border-radius:4px; font:inherit; }
  select { padding:8px; border:1px solid var(--rule-strong); border-radius:4px; font:inherit; background:var(--sheet); color:inherit; }
  #compose button.primary { margin-left:auto; }
  button.action { padding:8px 12px; border-radius:4px; border:1px solid var(--rule-strong); background:var(--sheet); font:inherit; font-weight:600; cursor:pointer; }
  button.primary { background:var(--ballpoint); color:#fff; border-color:var(--ballpoint); }
  .faults label { display:grid; grid-template-columns: 1fr 64px; gap:8px; padding:6px 12px; align-items:center; }
  .faults input { width:64px; }
  .note { color:var(--graphite); padding:8px 12px; margin:0; font-size:12px; }
  :focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
</style>
</head>
<body>
<header><h1>Customer phone</h1><span class="note">WhatsApp simulator. Messages go to the support desk as real webhooks.</span></header>
<main>
  <section class="customers" aria-labelledby="c-h"><h2 id="c-h">Customers</h2><div id="customers"></div></section>
  <section class="phone" aria-labelledby="p-h">
    <h2 id="p-h">No customer selected</h2>
    <div class="thread" id="thread" aria-live="polite"></div>
    <form id="compose">
      <label class="mono" for="text" style="position:absolute;left:-9999px">Message</label>
      <input id="text" type="text" dir="auto" autocomplete="off" placeholder="Write as the customer…" disabled>
      <label class="mono" for="lang" style="position:absolute;left:-9999px">Language spoken</label>
      <select id="lang" disabled><option value="en">English</option><option value="hi">Hindi</option><option value="ml">Malayalam</option><option value="ar">Arabic</option></select>
      <button class="action" type="button" id="voice" disabled title="Sends the text as a voice note in the chosen language">Send as voice note</button>
      <button class="action" type="button" id="image" disabled>Send photo</button>
      <button class="action primary" type="submit" disabled>Send</button>
    </form>
  </section>
  <section class="faults" aria-labelledby="f-h"><h2 id="f-h">Faults</h2><div id="faults"></div>
    <p class="note">Rates are 0 to 1. Use them to show duplicates, reordering and retries being handled.</p></section>
</main>
<script type="module">
const $ = (id) => document.getElementById(id);
let state = null, current = null;
const FAULTS = [['delayMs','Delay (ms)'],['reorderWindowMs','Reorder window (ms)'],['duplicateRate','Duplicate rate'],['failSendRate','Failed sends'],['rateLimitRate','Rate-limit errors'],['failedStatusRate','Failed statuses']];
async function load() {
  state = await (await fetch('/control/state')).json();
  const list = $('customers'); list.textContent = '';
  for (const b of state.businesses) {
    const h = document.createElement('p'); h.className = 'note'; h.textContent = 'To ' + b.name + ' · ' + b.displayPhoneNumber; list.append(h);
    for (const c of state.customers.filter((c) => c.businessPhoneNumberId === b.phoneNumberId)) {
      const btn = document.createElement('button');
      btn.textContent = c.name + (c.waId ? '' : ' (username only)');
      btn.setAttribute('aria-pressed', String(current === c.id));
      btn.onclick = () => select(c.id);
      list.append(btn);
    }
  }
  const f = $('faults'); f.textContent = '';
  for (const [key, label] of FAULTS) {
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = 'number'; i.step = key.endsWith('Ms') ? '50' : '0.05'; i.min = '0'; i.value = state.faults[key];
    i.onchange = () => fetch('/control/faults', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ [key]: Number(i.value) }) });
    l.append(i); f.append(l);
  }
}
async function select(id) {
  current = id; await load();
  const c = state.customers.find((c) => c.id === id);
  $('p-h').textContent = c.name;
  for (const el of $('compose').elements) el.disabled = false;
  await renderThread();
  fetch('/control/read/' + encodeURIComponent(id), { method: 'POST' });
}
async function renderThread() {
  if (!current) return;
  const messages = await (await fetch('/control/threads/' + encodeURIComponent(current))).json();
  const t = $('thread'); t.textContent = '';
  for (const m of messages) {
    const d = document.createElement('div'); d.className = 'msg ' + m.direction + (m.status === 'failed' ? ' failed' : '');
    d.dir = 'auto';
    if (m.type === 'audio' && m.mediaId) {
      const a = document.createElement('audio'); a.controls = true; a.src = '/control/media/' + encodeURIComponent(m.mediaId); a.style.maxWidth = '100%';
      const said = document.createElement('span'); said.textContent = m.text ? '“' + m.text + '”' : '';
      d.append(a, document.createElement('br'), said);
    } else d.textContent = m.text ?? '[' + m.type + ']';
    const meta = document.createElement('span'); meta.className = 'meta mono';
    meta.textContent = new Date(m.at).toLocaleTimeString() + (m.type === 'audio' ? ' · voice note' : '') + (m.direction === 'out' ? ' · from business · ' + m.status : ' · you');
    d.append(meta); t.append(d);
  }
  t.scrollTop = t.scrollHeight;
}
$('compose').onsubmit = async (e) => {
  e.preventDefault(); const text = $('text').value.trim(); if (!text || !current) return;
  $('text').value = '';
  await fetch('/control/messages', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ customerId: current, text }) });
};
$('voice').onclick = async () => {
  const text = $('text').value.trim(); if (!text || !current) { $('text').focus(); return; }
  $('text').value = '';
  await fetch('/control/messages', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ customerId: current, type: 'audio', text, language: $('lang').value }) });
};
$('image').onclick = () => current && fetch('/control/messages', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ customerId: current, type: 'image', caption: 'Photo from the customer' }) });
const events = new EventSource('/control/events');
events.addEventListener('thread', (e) => { if (JSON.parse(e.data).customerId === current) { renderThread(); fetch('/control/read/' + encodeURIComponent(current), { method: 'POST' }); } });
events.addEventListener('faults', load);
load();
</script>
</body>
</html>`;
}

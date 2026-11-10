// DP shop temperature monitor
// Polls every Govee thermometer on the account, keeps state between runs,
// sends Slack instructions to shops outside the comfort range, and rebuilds
// the dashboard. Node 20+, no dependencies.
//
// Env:
//   GOVEE_API_KEY     Govee developer API key (GitHub secret)
//   SLACK_BOT_TOKEN   Slack bot token with chat:write (GitHub secret)
//   DRY_RUN=1         print Slack messages instead of sending
//   MOCK=1            simulate sensors (testing without Govee)
//   NOW=<ISO date>    override the clock (testing)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const DASHBOARD_TEMPLATE = path.join(ROOT, 'src', 'dashboard.html');
const DASHBOARD_OUT = path.join(ROOT, 'docs', 'index.html');

const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const DRY_RUN = process.env.DRY_RUN === '1';
const MOCK = process.env.MOCK === '1';
const GOVEE = 'https://openapi.api.govee.com/router/api/v1';
const HISTORY_HOURS = 24;
const MIN = CONFIG.comfort.min;
const MAX = CONFIG.comfort.max;

// ---------- helpers ----------
const minsBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const round1 = (n) => Math.round(n * 10) / 10;
const fmtTime = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const fmtDuration = (mins) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h} hr${h > 1 ? 's' : ''}${m ? ` ${m} min` : ''}` : `${m} min`;
};

function isOpen(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const hours = CONFIG.openingHours[parts.weekday.toLowerCase().slice(0, 3)];
  if (!hours) return false;
  const [open, close] = hours.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  return now >= open && now < close;
}

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function localParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(date)).map((p) => [p.type, p.value])
  );
}
const localMinutes = (date) => { const p = localParts(date); return Number(p.hour) * 60 + Number(p.minute); };
const localDate = (date) => { const p = localParts(date); return `${p.year}-${p.month}-${p.day}`; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

// ---------- overnight check (results go to data/overnight.json, never Slack) ----------
const NIGHT = { checkFrom: '01:00', checkTo: '05:00', minReadings: 6, heatingRiseBy: 0.5, heatingStaysAbove: 19.5, relativeMargin: 2, coolingBelow: 16, ...(CONFIG.overnight || {}) };
const inCheckWindow = (ts) => { const m = localMinutes(ts); return m >= hm(NIGHT.checkFrom) && m < hm(NIGHT.checkTo); };

function summariseNight(t) {
  const pts = t.night.readings.filter(([ts]) => inCheckWindow(ts)).map(([, v]) => v);
  if (pts.length < NIGHT.minReadings) return null;
  const min = Math.min(...pts), max = Math.max(...pts);
  return {
    shop: t.shop, area: t.area,
    closeTemp: t.night.closeTemp, minTemp: round1(min), maxTemp: round1(max),
    avgTemp: round1(pts.reduce((a, b) => a + b, 0) / pts.length),
    drop: round1(t.night.closeTemp - min), rise: round1(max - t.night.closeTemp),
  };
}

function judgeNight(rows) {
  const med = round1(median(rows.map((r) => r.drop)));
  for (const r of rows) {
    const why = [];
    if (r.rise >= NIGHT.heatingRiseBy) why.push(`warmed up after closing (${r.closeTemp}°C at close, up to ${r.maxTemp}°C overnight)`);
    if (r.maxTemp > MAX) why.push(`above ${MAX}°C overnight (${r.maxTemp}°C)`);
    if (!why.length && r.minTemp >= NIGHT.heatingStaysAbove && r.drop <= Math.max(0.5, med - NIGHT.relativeMargin))
      why.push(`held at ${r.minTemp}°C or above all night, dropped only ${r.drop}°C (most shops dropped ${med}°C)`);
    if (why.length) { r.flag = 'heating'; r.reason = why.join('; '); continue; }
    if (r.minTemp < NIGHT.coolingBelow && r.drop >= med + NIGHT.relativeMargin) {
      r.flag = 'cooling'; r.reason = `fell to ${r.minTemp}°C, a ${r.drop}°C drop against ${med}°C for most shops`;
    }
  }
  return med;
}

function toCelsius(v) {
  const unit = CONFIG.temperatureUnitFromGovee;
  // Indoor readings: anything above 45 can only be Fahrenheit.
  const isF = unit === 'F' || (unit === 'auto' && v > 45);
  return round1(isF ? (v - 32) * 5 / 9 : v);
}

function shopFor(device) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dn = norm(device.deviceName);
  // every name a shop's sensors might use: its goveeName plus any aliases ("Fred st", "Wimslow rd")
  const names = CONFIG.shops.flatMap((x) => [x.goveeName, ...(x.aliases || [])].filter(Boolean).map((n) => [norm(n), x]));
  const s =
    CONFIG.shops.find((x) => x.goveeDevice === device.device) ||
    names.find(([n]) => n === dn)?.[1] ||
    // "Eastham staff" or "Upholland shop" -> that shop; longest name first so "Sale Moor" beats "Sale"
    names.filter(([n]) => n.length >= 4).sort((a, b) => b[0].length - a[0].length).find(([n]) => dn.includes(n))?.[1];
  // two sensors per shop: shop floor and behind the counter
  const zone = /staff|counter/i.test(device.deviceName || '') ? 'Staff area' : 'Customer area';
  return {
    shop: s ? `${s.shop} - ${zone}` : device.deviceName || device.device,
    shopName: s?.shop || null,
    zone: s ? zone : null,
    area: s?.area || (s ? 'Shops' : 'Not a shop sensor'),
    channel: s?.slackChannel || null, // unmapped sensors: dashboard only, no Slack
    mapped: Boolean(s),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// ---------- Govee ----------
async function govee(pathname, opts = {}) {
  const res = await fetch(GOVEE + pathname, {
    ...opts,
    headers: { 'Govee-API-Key': process.env.GOVEE_API_KEY, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.code && body.code !== 200)) {
    throw new Error(`Govee ${pathname} ${res.status}: ${body.message || body.msg || 'error'}`);
  }
  return body;
}

async function listThermometers() {
  const { data = [] } = await govee('/user/devices');
  const ignore = (CONFIG.ignoreSensors || []).map((n) => n.toLowerCase());
  return data.filter((d) => !ignore.includes(String(d.deviceName || '').toLowerCase().trim())).filter((d) =>
    d.type === 'devices.types.thermometer' ||
    (d.capabilities || []).some((c) => c.instance === 'sensorTemperature')
  );
}

async function readDevice(d) {
  try {
    const body = await govee('/device/state', {
      method: 'POST',
      body: JSON.stringify({ requestId: `dp-${Date.now()}`, payload: { sku: d.sku, device: d.device } }),
    });
    const caps = body.payload?.capabilities || [];
    const get = (inst) => caps.find((c) => c.instance === inst)?.state?.value;
    const online = get('online');
    const t = get('sensorTemperature');
    const h = get('sensorHumidity');
    if (online === false || typeof t !== 'number') return { online: false };
    return {
      online: true,
      tempC: toCelsius(t),
      humidity: typeof h === 'number' ? h : h?.currentHumidity ?? null,
    };
  } catch (err) {
    console.error(`Read failed for ${d.deviceName || d.device}: ${err.message}`);
    return { online: false, error: err.message };
  }
}

// ---------- mock sensors (testing only) ----------
function mockDevices() {
  const names = CONFIG.shops.map((s) => s.goveeName);
  return names.map((n, i) => ({ sku: 'H5179', device: `MOCK:${i}`, deviceName: n }));
}
function mockRead(d, prev) {
  const forced = JSON.parse(process.env.MOCK_TEMPS || '{}');
  if (forced[d.deviceName] === 'offline') return { online: false };
  if (forced[d.deviceName] !== undefined) return { online: true, tempC: forced[d.deviceName], humidity: 48 };
  const base = prev?.tempC ?? 19 + Math.random() * 3;
  return { online: true, tempC: round1(base + (Math.random() - 0.5) * 0.6), humidity: 45 + Math.round(Math.random() * 10) };
}

// ---------- Slack ----------
async function slack(channel, text) {
  if (!channel) return true; // sensor not linked to a shop: dashboard only
  // Slack not set up yet: log only, and don't count it as sent so the shop is told once Slack is live
  if (process.env.SLACK_PENDING === '1') { console.log(`[SLACK pending -> ${channel}] ${text.split('\n')[0]}`); return false; }
  if (DRY_RUN || !process.env.SLACK_BOT_TOKEN) {
    console.log(`\n[SLACK -> ${channel}]\n${text}`);
    return true;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) { console.error(`Slack post to ${channel} failed: ${body.error || res.status}`); return false; }
  return true;
}

const action = (status) => (status === 'cold' ? 'HEATING' : 'COOLING (air con)');
const word = (status) => (status === 'cold' ? 'cold' : 'warm');
const range = `${MIN}-${MAX}°C`;

const msg = {
  first: (s, t) =>
    `*TEMPERATURE ALERT - ${s.shop}*\nThe shop is too ${word(t.status)}: *${t.tempC.toFixed(1)}°C* (comfortable range ${range}).\n*Turn the ${action(t.status)} ON for 1 hour.* You will get a message when the shop is back in range.`,
  repeat: (s, t, mins) =>
    `*STILL TOO ${word(t.status).toUpperCase()} - ${s.shop}*\nNow *${t.tempC.toFixed(1)}°C*, ${fmtDuration(mins)} after the first alert.\n*Check the ${action(t.status)} is on and doors are closed. Keep it on for another hour.*`,
  recovered: (s, t, prevStatus) =>
    `*BACK IN RANGE - ${s.shop}*\nNow *${t.tempC.toFixed(1)}°C*. *Switch the ${action(prevStatus)} OFF.*`,
  escalate: (s, t, mins) =>
    `*ESCALATION - ${s.shop} (${s.area})*\nStill too ${word(t.status)} after ${fmtDuration(mins)} of alerts: *${t.tempC.toFixed(1)}°C* (range ${range}). First alert at ${fmtTime(t.firstAlertAt)}. Possible ${t.status === 'cold' ? 'heating' : 'cooling'} fault - please contact the shop.`,
  offline: (s, t) =>
    `*SENSOR OFFLINE - ${s.shop} (${s.area})*\nNo reading since ${t.lastReadingAt ? fmtTime(t.lastReadingAt) : 'first check'}. Check the sensor batteries and the Govee Wi-Fi gateway.`,
};

// ---------- main ----------
async function main() {
  if (!MOCK && !process.env.GOVEE_API_KEY) throw new Error('GOVEE_API_KEY is not set');
  if (!DRY_RUN && process.env.SLACK_PENDING !== '1' && !process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN is not set (use DRY_RUN=1 to test without Slack)');

  if (process.env.LIST_DEVICES === '1') {
    const devs = MOCK ? mockDevices() : await listThermometers();
    console.log(`Found ${devs.length} thermometers. Copy the names into config.json -> shops[].goveeName\n`);
    for (const d of devs) {
      const r = MOCK ? mockRead(d) : await readDevice(d);
      const s = shopFor(d);
      console.log(`${(d.deviceName || '(no name)').padEnd(30)} ${d.sku.padEnd(7)} ${d.device}  ${r.online ? r.tempC + '°C' : 'offline'}  ${s.mapped ? '-> ' + s.shop : 'NOT MAPPED'}`);
    }
    return;
  }

  let state = { devices: {} };
  try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { /* first run */ }

  const open = isOpen(NOW);
  const devices = MOCK ? mockDevices() : await listThermometers();
  const readings = await mapLimit(devices, 4, (d) => (MOCK ? mockRead(d, state.devices[d.device]) : readDevice(d)));
  const nowIso = NOW.toISOString();
  let sent = 0;

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const r = readings[i];
    const s = shopFor(d);
    const t = state.devices[d.device] || { status: 'unknown', history: [] };
    Object.assign(t, { shop: s.shop, area: s.area, mapped: s.mapped, checkedAt: nowIso });

    // --- offline handling ---
    if (!r.online) {
      const staleMins = t.lastReadingAt ? minsBetween(t.lastReadingAt, NOW) : Infinity;
      if (staleMins >= CONFIG.offlineAfterMinutes && t.status !== 'offline') {
        t.status = 'offline';
        t.offlineNotified = false;
      }
      if (t.status === 'offline' && open && !t.offlineNotified) {
        if (await slack(CONFIG.slack.escalationChannel, msg.offline(s, t))) { t.offlineNotified = true; sent++; }
      }
      state.devices[d.device] = t;
      continue;
    }

    // --- classify with hysteresis so readings hovering on the line don't flap ---
    const prev = t.status;
    const temp = r.tempC;
    let status;
    if (temp < MIN) status = 'cold';
    else if (temp > MAX) status = 'hot';
    else if (prev === 'cold' && temp < MIN + CONFIG.recoveryMargin) status = 'cold';
    else if (prev === 'hot' && temp > MAX - CONFIG.recoveryMargin) status = 'hot';
    else status = 'ok';

    Object.assign(t, { tempC: temp, humidity: r.humidity, lastReadingAt: nowIso });

    // overnight tracking: closing temperature, then every reading until opening
    if (open) {
      t.lastOpenTemp = temp;
      if (t.night?.done) delete t.night;
    } else {
      if (t.night && minsBetween(t.night.closedAt, NOW) > 20 * 60) delete t.night; // closed all day, start again
      if (!t.night) t.night = { closedAt: nowIso, closeTemp: t.lastOpenTemp ?? temp, readings: [] };
      t.night.readings.push([nowIso, temp]);
    }
    t.history = [...(t.history || []), [nowIso, temp]].filter(([ts]) => minsBetween(ts, NOW) <= HISTORY_HOURS * 60);

    const wasOut = prev === 'cold' || prev === 'hot';
    const isOut = status === 'cold' || status === 'hot';

    if (isOut && (!wasOut || prev !== status)) {
      // new breach (or flipped cold <-> hot)
      Object.assign(t, { status, since: nowIso, firstAlertAt: null, lastAlertAt: null, escalatedAt: null, alerts: 0 });
    } else {
      t.status = status;
    }

    if (isOut && open) {
      if (!t.lastAlertAt) {
        if (await slack(s.channel, msg.first(s, t))) { t.firstAlertAt = t.lastAlertAt = nowIso; t.alerts = 1; sent++; }
      } else if (t.alerts < (CONFIG.maxShopAlerts || 3) && minsBetween(t.lastAlertAt, NOW) >= CONFIG.realertAfterMinutes) {
        if (await slack(s.channel, msg.repeat(s, t, minsBetween(t.firstAlertAt, NOW)))) { t.lastAlertAt = nowIso; t.alerts++; sent++; }
      }
      if (t.firstAlertAt && !t.escalatedAt && minsBetween(t.firstAlertAt, NOW) >= CONFIG.escalateAfterMinutes) {
        if (await slack(CONFIG.slack.escalationChannel, msg.escalate(s, t, minsBetween(t.firstAlertAt, NOW)))) { t.escalatedAt = nowIso; sent++; }
      }
    }

    if (!isOut && wasOut) {
      // only tell the shop to switch off if they were told to switch on
      if (t.firstAlertAt && open) { if (await slack(s.channel, msg.recovered(s, t, prev))) sent++; }
      Object.assign(t, { since: nowIso, firstAlertAt: null, lastAlertAt: null, escalatedAt: null, alerts: 0 });
    }
    if (!isOut && prev === 'offline') t.since = nowIso;
    t.offlineNotified = false;
    state.devices[d.device] = t;
  }

  // finalise the overnight report once the check window has passed (or shops reopen)
  const pending = Object.values(state.devices).filter((t) => t.night && !t.night.done);
  if (pending.length && (open || localMinutes(NOW) >= hm(NIGHT.checkTo)) && localMinutes(NOW) < 12 * 60) {
    const rows = [], noData = [];
    for (const t of pending) {
      const sum = summariseNight(t);
      sum ? rows.push(sum) : noData.push(t.shop);
      t.night.done = true;
    }
    for (const t of Object.values(state.devices)) if (t.status === 'offline' && !noData.includes(t.shop)) noData.push(t.shop);
    if (rows.length) {
      const med = judgeNight(rows);
      const nightOf = localDate(new Date(NOW - 12 * 3600e3));
      const flagged = rows.filter((r) => r.flag).sort((a, b) => a.area.localeCompare(b.area) || a.shop.localeCompare(b.shop));
      const OVERNIGHT_FILE = path.join(ROOT, 'data', 'overnight.json');
      let prevReport = {};
      try { prevReport = JSON.parse(await fs.readFile(OVERNIGHT_FILE, 'utf8')); } catch { /* none yet */ }
      const history = [{ night: nightOf, flagged: flagged.map((r) => r.shop) }, ...(prevReport.history || []).filter((h) => h.night !== nightOf)].slice(0, 14);
      for (const r of flagged) r.nightsFlaggedLast14 = history.filter((h) => h.flagged.includes(r.shop)).length;
      const report = {
        night: nightOf, generatedAt: nowIso, checkWindow: `${NIGHT.checkFrom}-${NIGHT.checkTo}`,
        shopsChecked: rows.length, estateMedianDrop: med, flagged, noData, allShops: rows, history,
      };
      await fs.mkdir(path.dirname(OVERNIGHT_FILE), { recursive: true });
      await fs.writeFile(OVERNIGHT_FILE, JSON.stringify(report, null, 2));
      console.log(`Overnight report for ${nightOf}: ${flagged.length} flagged of ${rows.length} (median drop ${med}°C)`);
    }
  }

  // drop sensors removed from the Govee account
  for (const [id, t] of Object.entries(state.devices)) {
    if (minsBetween(t.checkedAt, NOW) > 24 * 60) delete state.devices[id];
  }

  state.updatedAt = nowIso;
  state.shopsOpen = open;
  state.comfort = { min: MIN, max: MAX };

  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  const template = await fs.readFile(DASHBOARD_TEMPLATE, 'utf8');
  const html = template.replace('/*__DATA__*/null', JSON.stringify(state).replace(/</g, '\\u003c'));
  await fs.mkdir(path.dirname(DASHBOARD_OUT), { recursive: true });
  await fs.writeFile(DASHBOARD_OUT, html);

  const counts = Object.values(state.devices).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
  console.log(`\n${nowIso} | shops ${open ? 'OPEN' : 'CLOSED'} | ${devices.length} sensors | ${JSON.stringify(counts)} | ${sent} Slack messages`);
}

main().catch((err) => { console.error(err); process.exit(1); });

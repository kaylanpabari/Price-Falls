// Price alerts: each device registers its waitlist (game id + target price).
// A background job checks prices and sends an Expo push notification when a
// game drops to (or below) the target.
//
// Storage is a JSON file. On Render's free tier the disk is wiped on every
// deploy/restart, so for production point DATA_FILE at a persistent disk or
// swap this module for Turso/SQLite. The app re-syncs its waitlist on every
// launch, so a wipe only means alerts pause until users next open the app.

const fs = require('fs');
const path = require('path');
const { Expo } = require('expo-server-sdk');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'alerts.json');
const MAX_ITEMS_PER_DEVICE = 200;
const PRICE_BATCH = 100;

class AlertStore {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.devices = {}; // token -> { country, items: [{id,title,target,lastNotified}], updated }
    this.load();
  }

  load() {
    try {
      this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.devices = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.devices));
    fs.renameSync(tmp, this.file);
  }

  register(token, country, items) {
    const previous = this.devices[token]?.items || [];
    const prevById = Object.fromEntries(previous.map((i) => [i.id, i]));
    this.devices[token] = {
      country,
      updated: Date.now(),
      items: items.slice(0, MAX_ITEMS_PER_DEVICE).map((i) => {
        const old = prevById[i.id];
        // Keep "already notified" state unless the user changed the target.
        const keep = old && old.target === i.target;
        return {
          id: i.id,
          title: String(i.title || '').slice(0, 200),
          target: i.target,
          lastNotified: keep ? old.lastNotified ?? null : null,
        };
      }),
    };
    this.save();
    return this.devices[token];
  }

  remove(token) {
    delete this.devices[token];
    this.save();
  }
}

function validateRegistration(body) {
  const { token, country, items } = body || {};
  if (!Expo.isExpoPushToken(token)) return 'token must be an Expo push token';
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return 'country must be a 2-letter code';
  if (!Array.isArray(items)) return 'items must be an array';
  for (const i of items) {
    if (!i || typeof i.id !== 'string') return 'each item needs an id';
    if (i.target !== null && (typeof i.target !== 'number' || i.target < 0)) {
      return 'target must be a positive number or null';
    }
  }
  return null;
}

// Decide which pushes to send. Pure function, so it is easy to test.
// pricesByCountry: { GB: { [gameId]: { amount, currency, shop } } }
function findTriggered(devices, pricesByCountry) {
  const out = [];
  for (const [token, dev] of Object.entries(devices)) {
    const prices = pricesByCountry[dev.country] || {};
    for (const item of dev.items) {
      const best = prices[item.id];
      if (!best || item.target === null || item.target === undefined) continue;
      const hit = best.amount <= item.target;
      const alreadySent = item.lastNotified !== null && item.lastNotified <= best.amount;
      if (hit && !alreadySent) out.push({ token, item, best });
      // Price went back above target: re-arm so the next drop alerts again.
      if (!hit && item.lastNotified !== null) item.lastNotified = null;
    }
  }
  return out;
}

async function fetchBestPrices(itad, devices) {
  const idsByCountry = {};
  for (const dev of Object.values(devices)) {
    idsByCountry[dev.country] ??= new Set();
    dev.items.forEach((i) => idsByCountry[dev.country].add(i.id));
  }

  const result = {};
  for (const [country, idSet] of Object.entries(idsByCountry)) {
    result[country] = {};
    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += PRICE_BATCH) {
      const batch = ids.slice(i, i + PRICE_BATCH);
      const raw = await itad.prices(batch, country);
      for (const entry of raw) {
        let best = null;
        for (const d of entry.deals || []) {
          if (d.price && (!best || d.price.amount < best.amount)) {
            best = { amount: d.price.amount, currency: d.price.currency, shop: d.shop?.name };
          }
        }
        if (best) result[country][entry.id] = best;
      }
    }
  }
  return result;
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ''}`.trim();
  }
}

async function runAlertCheck({ store, itad, expo = new Expo(), log = console }) {
  const devices = store.devices;
  if (Object.keys(devices).length === 0) return { checked: 0, sent: 0 };

  const prices = await fetchBestPrices(itad, devices);
  const triggered = findTriggered(devices, prices);

  const messages = triggered.map(({ token, item, best }) => ({
    to: token,
    sound: 'default',
    title: `${item.title || 'A game'} is on sale`,
    body: `${formatMoney(best.amount, best.currency)}${best.shop ? ` at ${best.shop}` : ''} (your target: ${formatMoney(item.target, best.currency)})`,
    data: { gameId: item.id },
  }));

  let sent = 0;
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((t, idx) => {
        const msg = chunk[idx];
        if (t.status === 'ok') sent++;
        // Uninstalled app: forget the device.
        if (t.details?.error === 'DeviceNotRegistered') delete devices[msg.to];
      });
    } catch (err) {
      log.error('Push send failed:', err.message);
    }
  }

  for (const { item, best } of triggered) item.lastNotified = best.amount;
  store.save();
  return { checked: Object.keys(devices).length, sent };
}

module.exports = { AlertStore, validateRegistration, findTriggered, fetchBestPrices, runAlertCheck };

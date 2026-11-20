const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { AlertStore, findTriggered, runAlertCheck } = require('../src/alerts');

const GAME_ID = '018d937f-6193-709d-abb2-957fd9982d2f';
const gbp = (amount) => ({ amount, amountInt: Math.round(amount * 100), currency: 'GBP' });

const fakeItad = {
  calls: [],
  async search(title) {
    this.calls.push(['search', title]);
    return [{ id: GAME_ID, slug: 'cyberpunk-2077', title: 'Cyberpunk 2077', type: 'game', mature: true, assets: { boxart: 'b.jpg', banner400: 'x.jpg' } }];
  },
  async deals() {
    return {
      nextOffset: 20,
      hasMore: true,
      list: [{ id: GAME_ID, slug: 'cyberpunk-2077', title: 'Cyberpunk 2077', assets: {}, deal: { shop: { id: 61, name: 'Steam' }, price: gbp(15.99), regular: gbp(49.99), cut: 68, url: 'https://itad.link/abc', drm: [{ id: 1, name: 'Steam' }] } }],
    };
  },
  async info() {
    return { id: GAME_ID, slug: 'cyberpunk-2077', title: 'Cyberpunk 2077', assets: {}, tags: ['RPG'], developers: [{ id: 1, name: 'CD PROJEKT RED' }], reviews: [{ source: 'Steam', score: 80, count: 1000 }] };
  },
  async prices(ids) {
    return ids.map((id) => ({
      id,
      historyLow: { all: gbp(12.49), y1: gbp(15.99), m3: gbp(15.99) },
      deals: [
        { shop: { id: 35, name: 'GOG' }, price: gbp(19.99), regular: gbp(49.99), cut: 60, url: 'g' },
        { shop: { id: 61, name: 'Steam' }, price: gbp(15.99), regular: gbp(49.99), cut: 68, url: 's' },
      ],
    }));
  },
  async lookup() {
    return { found: false };
  },
};

function tmpStore() {
  return new AlertStore(path.join(os.tmpdir(), `alerts-${process.pid}-${Math.random()}.json`));
}

async function withServer(fn, opts = {}) {
  const app = createApp({ itad: fakeItad, store: tmpStore(), appToken: '', ...opts });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('search returns normalised games and caches', async () => {
  await withServer(async (base) => {
    fakeItad.calls = [];
    const r1 = await (await fetch(`${base}/api/search?q=cyber`)).json();
    await fetch(`${base}/api/search?q=Cyber`);
    assert.equal(r1.results[0].title, 'Cyberpunk 2077');
    assert.equal(r1.results[0].images.banner, 'x.jpg');
    assert.equal(fakeItad.calls.length, 1, 'second call should be cached');
  });
});

test('deals list is normalised', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/deals?country=gb`)).json();
    assert.equal(r.hasMore, true);
    assert.equal(r.list[0].deal.shop.name, 'Steam');
    assert.deepEqual(r.list[0].deal.price, { amount: 15.99, currency: 'GBP' });
    assert.deepEqual(r.list[0].deal.drm, ['Steam']);
  });
});

test('game page merges info + prices, cheapest first', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/games/${GAME_ID}?country=GB`)).json();
    assert.equal(r.title, 'Cyberpunk 2077');
    assert.deepEqual(r.developers, ['CD PROJEKT RED']);
    assert.equal(r.deals[0].shop.name, 'Steam');
    assert.equal(r.historyLow.all.amount, 12.49);
  });
});

test('rejects bad game id and enforces app token', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/games/not-a-uuid`)).status, 400);
  });
  await withServer(
    async (base) => {
      assert.equal((await fetch(`${base}/api/deals`)).status, 401);
      assert.equal((await fetch(`${base}/api/deals`, { headers: { 'X-App-Token': 's3cret' } })).status, 200);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    },
    { appToken: 's3cret' }
  );
});

test('alert registration validates input', async () => {
  await withServer(async (base) => {
    const post = (body) =>
      fetch(`${base}/api/alerts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ token: 'nope', country: 'GB', items: [] })).status, 400);
    const ok = await post({ token: 'ExponentPushToken[abc123]', country: 'GB', items: [{ id: GAME_ID, title: 'CP', target: 20 }] });
    assert.equal(ok.status, 200);
  });
});

test('findTriggered fires once, then re-arms after price rises', () => {
  const devices = { T: { country: 'GB', items: [{ id: 'g', title: 'G', target: 10, lastNotified: null }] } };
  assert.equal(findTriggered(devices, { GB: { g: { amount: 9 } } }).length, 1);
  devices.T.items[0].lastNotified = 9;
  assert.equal(findTriggered(devices, { GB: { g: { amount: 9 } } }).length, 0, 'no repeat at same price');
  assert.equal(findTriggered(devices, { GB: { g: { amount: 8 } } }).length, 1, 'fires again if it drops further');
  findTriggered(devices, { GB: { g: { amount: 12 } } });
  assert.equal(devices.T.items[0].lastNotified, null, 're-armed');
});

test('runAlertCheck sends a push for a game under target', async () => {
  const store = tmpStore();
  store.register('ExponentPushToken[abc]', 'GB', [{ id: GAME_ID, title: 'Cyberpunk 2077', target: 16 }]);
  const sent = [];
  const fakeExpo = {
    chunkPushNotifications: (m) => [m],
    sendPushNotificationsAsync: async (chunk) => {
      sent.push(...chunk);
      return chunk.map(() => ({ status: 'ok' }));
    },
  };
  const r = await runAlertCheck({ store, itad: fakeItad, expo: fakeExpo });
  assert.equal(r.sent, 1);
  assert.match(sent[0].body, /£15\.99 at Steam/);
  const again = await runAlertCheck({ store, itad: fakeItad, expo: fakeExpo });
  assert.equal(again.sent, 0);
});

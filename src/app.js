const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { TTLCache } = require('./cache');
const N = require('./normalize');
const { validateRegistration } = require('./alerts');

const MIN = 60 * 1000;
const COUNTRY_RE = /^[A-Z]{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const SORTS = new Set(['-trending', '-cut', 'price', '-price', '-time', 'title']);

function createApp({ itad, store, appToken = process.env.APP_TOKEN }) {
  const app = express();
  const cache = new TTLCache();

  app.set('trust proxy', 1); // Render/Railway sit behind a proxy
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ windowMs: MIN, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  // Optional shared secret so random people can't use your server as a free ITAD proxy.
  // Not real security (it ships inside the app), but stops casual abuse.
  if (appToken) {
    app.use('/api', (req, res, next) => {
      if (req.get('X-App-Token') !== appToken) return res.status(401).json({ error: 'Unauthorized' });
      next();
    });
  }

  const country = (req) => {
    const c = String(req.query.country || 'GB').toUpperCase();
    return COUNTRY_RE.test(c) ? c : 'GB';
  };

  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get(
    '/api/search',
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ results: [] });
      if (q.length > 100) return res.status(400).json({ error: 'Query too long' });
      const results = await cache.wrap(`search:${q.toLowerCase()}`, 30 * MIN, async () =>
        (await itad.search(q, 25)).map(N.gameSummary)
      );
      res.json({ results });
    })
  );

  app.get(
    '/api/deals',
    wrap(async (req, res) => {
      const c = country(req);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      // No sort = ITAD's default ordering (trending).
      const sort = SORTS.has(req.query.sort) ? req.query.sort : undefined;
      const data = await cache.wrap(`deals:${c}:${sort || 'default'}:${offset}:${limit}`, 10 * MIN, async () =>
        N.dealsList(await itad.deals({ country: c, offset, limit, sort }))
      );
      res.json(data);
    })
  );

  app.get(
    '/api/games/:id',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid game id' });
      const c = country(req);
      const [info, prices] = await Promise.all([
        cache.wrap(`info:${id}`, 6 * 60 * MIN, async () => N.gameInfo(await itad.info(id))),
        cache.wrap(`prices:${id}:${c}`, 10 * MIN, async () => {
          const raw = await itad.prices([id], c);
          return N.gamePrices(raw.find((e) => e.id === id));
        }),
      ]);
      res.json({ ...info, ...prices, country: c });
    })
  );

  // Steam appid -> ITAD game (handy for a "paste a Steam link" feature)
  app.get(
    '/api/lookup/steam/:appid',
    wrap(async (req, res) => {
      const appid = parseInt(req.params.appid, 10);
      if (!appid) return res.status(400).json({ error: 'Invalid appid' });
      const data = await cache.wrap(`lookup:${appid}`, 24 * 60 * MIN, () => itad.lookup({ appid }));
      res.json(data.found ? { found: true, game: N.gameSummary(data.game) } : { found: false });
    })
  );

  app.post('/api/alerts/register', (req, res) => {
    const error = validateRegistration(req.body);
    if (error) return res.status(400).json({ error });
    const { token, country: c, items } = req.body;
    const dev = store.register(token, c, items);
    res.json({ ok: true, items: dev.items.length });
  });

  app.delete('/api/alerts/:token', (req, res) => {
    store.remove(req.params.token);
    res.json({ ok: true });
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 502;
    console.error(err.message);
    res.status(status).json({ error: status === 502 ? 'Upstream error, try again shortly' : err.message });
  });

  return app;
}

module.exports = { createApp };

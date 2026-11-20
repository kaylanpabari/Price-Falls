// Thin client for the IsThereAnyDeal API (https://docs.isthereanydeal.com).
// All ITAD-specific paths live in ENDPOINTS so that if ITAD bumps a version
// (e.g. prices/v3 -> prices/v4) you only change it here.

const BASE_URL = process.env.ITAD_BASE_URL || 'https://api.isthereanydeal.com';

const ENDPOINTS = {
  search: '/games/search/v1', // GET  ?title=&results=
  lookup: '/games/lookup/v1', // GET  ?title= | ?appid=
  info: '/games/info/v2', //     GET  ?id=
  prices: '/games/prices/v3', // POST ?country=&deals=  body: [ids]
  deals: '/deals/v2', //         GET  ?country=&offset=&limit=&sort=
  shops: '/service/shops/v1', // GET  ?country=
};

class ItadError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function getKey() {
  const key = process.env.ITAD_API_KEY;
  if (!key) throw new ItadError('ITAD_API_KEY is not set on the server', 500);
  return key;
}

async function request(path, { query = {}, body, fetchImpl = fetch } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetchImpl(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'ITAD-API-Key': getKey(),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ItadError(`ITAD ${path} failed (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

module.exports = {
  ENDPOINTS,
  ItadError,
  request,
  search: (title, results = 20) => request(ENDPOINTS.search, { query: { title, results } }),
  lookup: (params) => request(ENDPOINTS.lookup, { query: params }),
  info: (id) => request(ENDPOINTS.info, { query: { id } }),
  prices: (ids, country) =>
    request(ENDPOINTS.prices, { query: { country }, body: ids }),
  deals: ({ country, offset = 0, limit = 20, sort }) =>
    request(ENDPOINTS.deals, { query: { country, offset, limit, sort } }),
  shops: (country) => request(ENDPOINTS.shops, { query: { country } }),
};

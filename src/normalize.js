// Turns raw ITAD responses into small, stable shapes for the app.
// If ITAD changes a field name, fix it here and the app keeps working.

function price(p) {
  if (!p || typeof p.amount !== 'number') return null;
  return { amount: p.amount, currency: p.currency || null };
}

function image(assets = {}) {
  return {
    boxart: assets.boxart || null,
    banner: assets.banner400 || assets.banner300 || assets.banner600 || assets.banner145 || null,
    bannerLarge: assets.banner600 || assets.banner400 || null,
  };
}

function gameSummary(g) {
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    type: g.type || null,
    mature: !!g.mature,
    images: image(g.assets),
  };
}

function deal(d) {
  if (!d) return null;
  return {
    shop: d.shop ? { id: d.shop.id, name: d.shop.name } : null,
    price: price(d.price),
    regular: price(d.regular),
    cut: typeof d.cut === 'number' ? d.cut : 0,
    storeLow: price(d.storeLow),
    historyLow: price(d.historyLow),
    voucher: d.voucher || null,
    drm: Array.isArray(d.drm) ? d.drm.map((x) => x.name).filter(Boolean) : [],
    platforms: Array.isArray(d.platforms) ? d.platforms.map((x) => x.name).filter(Boolean) : [],
    url: d.url || null,
    expiry: d.expiry || null,
    flag: d.flag || null,
  };
}

function dealsList(raw) {
  return {
    nextOffset: raw.nextOffset ?? null,
    hasMore: !!raw.hasMore,
    list: (raw.list || []).map((item) => ({ ...gameSummary(item), deal: deal(item.deal) })),
  };
}

function gameInfo(info) {
  return {
    ...gameSummary(info),
    earlyAccess: !!info.earlyAccess,
    releaseDate: info.releaseDate || null,
    developers: (info.developers || []).map((d) => d.name),
    publishers: (info.publishers || []).map((d) => d.name),
    tags: info.tags || [],
    reviews: (info.reviews || []).map((r) => ({
      source: r.source,
      score: r.score,
      count: r.count ?? null,
      url: r.url || null,
    })),
    steamAppId: info.appid ?? null,
  };
}

function gamePrices(entry) {
  if (!entry) return { historyLow: { all: null, y1: null, m3: null }, deals: [] };
  const deals = (entry.deals || []).map(deal).filter((d) => d.price);
  deals.sort((a, b) => a.price.amount - b.price.amount);
  return {
    historyLow: {
      all: price(entry.historyLow?.all),
      y1: price(entry.historyLow?.y1),
      m3: price(entry.historyLow?.m3),
    },
    deals,
  };
}

module.exports = { price, gameSummary, deal, dealsList, gameInfo, gamePrices };

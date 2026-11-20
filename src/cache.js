// Tiny in-memory TTL cache. Keeps you well inside ITAD's rate limits:
// 1,000 users opening the same deals page = 1 ITAD request per TTL.

class TTLCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.map = new Map();
    this.maxEntries = maxEntries;
    this.inflight = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.maxEntries) {
      // Drop the oldest entry (Map keeps insertion order).
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  // Return cached value, or run fn once (even if many requests arrive at once).
  async wrap(key, ttlMs, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { TTLCache };

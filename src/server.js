const itad = require('./itad');
const { createApp } = require('./app');
const { AlertStore, runAlertCheck } = require('./alerts');

if (!process.env.ITAD_API_KEY) {
  console.error('Missing ITAD_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const ALERT_INTERVAL_MIN = Number(process.env.ALERT_INTERVAL_MIN || 60);

const store = new AlertStore();
const app = createApp({ itad, store });

app.listen(PORT, () => console.log(`Deal backend listening on :${PORT}`));

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const r = await runAlertCheck({ store, itad });
    if (r.checked) console.log(`Alert check: ${r.checked} devices, ${r.sent} pushes sent`);
  } catch (err) {
    console.error('Alert check failed:', err.message);
  } finally {
    running = false;
  }
}

if (ALERT_INTERVAL_MIN > 0) {
  setTimeout(tick, 30 * 1000);
  setInterval(tick, ALERT_INTERVAL_MIN * 60 * 1000);
}

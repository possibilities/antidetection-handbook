// Service worker: same report. Registered with a scope under /sw-scope/.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const n = self.navigator;
fetch('/__collect', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'realm', realm: 'service-worker',
    userAgent: n.userAgent, languages: [...(n.languages||[])], platform: n.platform,
    hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hasWebdriver: 'webdriver' in n, webdriver: n.webdriver ?? null,
    uaBrands: n.userAgentData ? n.userAgentData.brands : null }) });

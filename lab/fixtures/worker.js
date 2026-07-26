// Dedicated worker: reports its own view of the shared system surfaces.
const n = self.navigator;
fetch('/__collect', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'realm', realm: 'dedicated-worker',
    userAgent: n.userAgent, languages: [...(n.languages||[])], platform: n.platform,
    hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hasWebdriver: 'webdriver' in n, webdriver: n.webdriver ?? null,
    uaBrands: n.userAgentData ? n.userAgentData.brands : null }) });

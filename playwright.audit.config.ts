import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',testMatch:['app-audit.spec.ts','release-journeys.spec.ts','redesign-*.spec.ts'],timeout:30000,workers:3,retries:0,
  reporter:[['list'],['json',{outputFile:'output/playwright/audit-results.json'}]],
  outputDir:'./output/playwright/audit',
  use:{baseURL:process.env.E2E_BASE_URL || 'http://127.0.0.1:8090',screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command:'node scripts/serve-audit.mjs',url:'http://127.0.0.1:8090/login',reuseExistingServer:!process.env.CI,
  },
  projects:[
    {name:'desktop',use:{browserName:'chromium',viewport:{width:1440,height:1000}}},
    {name:'tablet',use:{browserName:'chromium',viewport:{width:834,height:1112}}},
    {name:'phone',use:{browserName:'chromium',viewport:{width:390,height:844}}},
    {name:'small-phone',use:{browserName:'chromium',viewport:{width:320,height:740}},grep:/critical|login/},
    {name:'tablet-boundary',use:{browserName:'chromium',viewport:{width:768,height:1024}},grep:/critical|login/},
    {name:'tablet-landscape',use:{browserName:'chromium',viewport:{width:1024,height:768}},grep:/critical|login/},
    // Fixture phone numbers must not launch Firefox's external dialer dialog,
    // which consumes subsequent native page clicks in headless acceptance.
    {name:'firefox',use:{browserName:'firefox',viewport:{width:1440,height:1000},launchOptions:{firefoxUserPrefs:{'network.protocol-handler.external.tel':false}}},grep:/critical|login/},
    {name:'webkit',use:{browserName:'webkit',viewport:{width:390,height:844}},grep:/critical|login/},
  ],
});

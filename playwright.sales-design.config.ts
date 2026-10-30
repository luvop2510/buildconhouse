import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./e2e',testMatch:['sales-analytics.spec.ts','sales-redesign.spec.ts'],timeout:30000,retries:0,
 outputDir:'output/playwright/sales-design',reporter:[['list'],['json',{outputFile:'output/playwright/sales-design-results.json'}]],
 use:{baseURL:process.env.E2E_BASE_URL||'http://127.0.0.1:8194',screenshot:'only-on-failure',trace:'retain-on-failure'},
 webServer:process.env.E2E_BASE_URL?undefined:{command:'AUDIT_PORT=8194 node scripts/serve-audit.mjs',url:'http://127.0.0.1:8194/login',reuseExistingServer:true},
 projects:[
  {name:'small-phone',use:{browserName:'chromium',viewport:{width:320,height:740}}},
  {name:'phone',use:{browserName:'chromium',viewport:{width:390,height:844}}},
  {name:'tablet',use:{browserName:'chromium',viewport:{width:834,height:1112}}},
  {name:'tablet-boundary',testMatch:'**/sales-redesign.spec.ts',use:{browserName:'chromium',viewport:{width:768,height:1024}}},
  {name:'tablet-landscape',testMatch:'**/sales-redesign.spec.ts',use:{browserName:'chromium',viewport:{width:1024,height:768}}},
  {name:'desktop',use:{browserName:'chromium',viewport:{width:1440,height:1000}}},
 ],
});

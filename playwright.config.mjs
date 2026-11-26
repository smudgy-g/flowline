import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  workers: 1,
  maxFailures: 0,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    browserName: 'chromium',
    launchOptions: { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] },
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['json', { outputFile: process.env.UAT_PLAYWRIGHT_REPORT ?? '.cache/playwright.json' }]],
  outputDir: '.cache/test-results',
})

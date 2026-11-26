import { test, expect } from '@playwright/test'

const supplier = 'supplier@cloud-city.test'
const password = 'password123'

async function rejectCookies(page) {
  const reject = page.getByRole('button', { name: 'Alle ablehnen' })
  await reject.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  if (await reject.isVisible()) {
    await reject.click()
    await expect(reject).toBeHidden()
  }
}

async function signIn(page, email = supplier) {
  await page.goto('/login')
  await rejectCookies(page)
  await page.getByRole('textbox', { name: 'E-Mail' }).fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.getByRole('button', { name: 'Jetzt einloggen' }).click()
  await expect(page).toHaveURL(/\/plattform\/dashboard/)
}

test('rent a LKW from its Google landing page', async ({ page }) => {
  await page.goto('/mieten/lkw')
  await rejectCookies(page)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('LKW')
  await page.getByRole('link', { name: 'Jetzt Angebote finden' }).click()
  // ponytail: both forms until the #1435 stack lands on staging; then keep only the query form
  await expect(page).toHaveURL(/\/search\/lkw|[?&]category=lkw/)
  await expect(page.getByText('Cloud Car Premium Lease')).toBeVisible()
  await page.locator('a[href^="/mieten/angebot/"]').first().click()
  await expect(page.getByRole('heading', { name: 'Cloud Car Premium Lease' })).toBeVisible()
  await expect(page.getByText(/2670\s*€/)).toBeVisible()
})

test('buy a vehicle through the public search', async ({ page }) => {
  await page.goto('/kaufen/suche')
  await rejectCookies(page)
  await expect(page.getByText('3 Kaufen Angebote gefunden')).toBeVisible()
  await page.getByRole('tab', { name: 'Privat' }).click()
  await expect(page.getByText('1 Kaufen Angebote gefunden')).toBeVisible()
  await page.getByRole('link', { name: 'Zum Angebot' }).first().click()
  await expect(page.getByText('BMW 320d Touring M Sport').first()).toBeVisible()
})

test('priced LKW schema and imageless transporter fallback', async ({ page }) => {
  async function graphFor(path) {
    await page.goto(path)
    return (await page.locator('script[type="application/ld+json"]').allTextContents())
      .flatMap(text => { const json = JSON.parse(text); return json['@graph'] ?? [json] })
  }
  const priced = await graphFor('/mieten/lkw')
  expect(priced.some(node => node.aggregateRating)).toBe(false)
  const list = priced.find(node => node['@type'] === 'ItemList')
  expect(list).toBeDefined()
  const entries = list.itemListElement ?? []
  expect(entries.length).toBeGreaterThan(0)
  expect(list.numberOfItems).toBe(entries.length)
  for (const { item } of entries) {
    expect(item?.['@type']).toBe('Product')
    expect(item?.offers?.['@type']).toBe('Offer')
    expect(item?.offers?.price).toBeGreaterThan(0)
    expect(item?.offers?.priceCurrency).toBe('EUR')
    expect(item?.image).toMatch(/^https:\/\//)
  }

  const fallback = await graphFor('/mieten/transporter')
  expect(fallback.some(node => node['@type'] === 'Product')).toBe(false)
  const subtypeList = fallback.find(node => node['@type'] === 'ItemList')
  expect(subtypeList).toBeDefined()
  expect(subtypeList.itemListElement?.length).toBeGreaterThan(0)
  expect(subtypeList.numberOfItems).toBe(subtypeList.itemListElement.length)
  for (const entry of subtypeList.itemListElement) {
    expect(entry.item).toBeUndefined()
    expect(entry.url).toMatch(/\/mieten\/transporter\//)
  }
})

test('customer inquiry reaches the supplier portal', async ({ page }) => {
  test.setTimeout(60000)
  await page.goto('/mieten/lkw')
  await rejectCookies(page)
  await page.getByRole('link', { name: 'Zum Angebot' }).first().click()
  await page.getByRole('button', { name: 'Kostenlos anfragen' }).click()
  // A distinct customer identity proves that this run's inquiry, not seed data, arrived.
  const email = `uat-${Date.now()}@example.com`
  const inquiry = page.locator('form').filter({ has: page.getByRole('button', { name: 'Kostenlos anfragen' }) })
  await expect(inquiry).toBeVisible()
  await inquiry.getByRole('textbox', { name: /Vorname/i }).fill('UAT')
  await inquiry.getByRole('textbox', { name: /Nachname/i }).fill('Anfrage')
  await inquiry.getByRole('textbox', { name: /E-Mail/i }).fill(email)
  await inquiry.locator('input[type=tel]').fill('17012345678')
  await inquiry.getByRole('textbox', { name: /Firma/i }).fill('UAT Test GmbH')
  // Business inquiries ask for the legal form once the qualification-v2 stack (#1449) is in; until then there is none.
  const legalForm = inquiry.getByRole('radio', { name: 'Körperschaft' })
  if (await legalForm.count()) await legalForm.check()
  await inquiry.getByRole('textbox', { name: /Straße/i }).fill('Teststraße')
  await inquiry.getByRole('textbox', { name: /Hausnummer/i }).fill('12')
  await inquiry.getByRole('textbox', { name: /PLZ/i }).fill('10115')
  await inquiry.getByRole('textbox', { name: /Stadt/i }).fill('Berlin')
  await inquiry.getByRole('radio', { name: 'Sofort' }).check()
  await inquiry.getByRole('button', { name: 'Kostenlos anfragen' }).click()
  await expect.poll(async () => (await (await page.request.get('http://127.0.0.1:55354/received')).json()))
    .toEqual(expect.arrayContaining([expect.objectContaining({
      to: ['lobot@cloud-city.test'],
      subject: 'Ein Kunde fragt Ihr Fahrzeug an',
    })]))
  await expect(page).toHaveURL(/requested=1/, { timeout: 12000 })
  await signIn(page)
  await page.getByRole('link', { name: 'Kundenanfragen' }).click()
  await page.getByRole('button', { name: /UAT Anfrage UAT Test GmbH/ }).click()
  await expect(page.getByRole('link', { name: email })).toBeVisible()
})

test('supplier creates, autosaves and publishes an offer', async ({ page }) => {
  // Google autocomplete is external; the seeded place ID resolves through the local app cache.
  await page.route('**/api/locations/predictions**', route => route.fulfill({
    json: [{ place_id: 'seed-berlin', description: 'Berlin, Deutschland' }],
  }))
  await signIn(page)
  await page.getByRole('link', { name: 'Meine Angebote' }).click()
  await page.getByRole('button', { name: /Angebot erstellen/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Neues Inserat erstellen' })
  const title = `UAT Browser Rental ${Date.now()}`
  await dialog.getByRole('textbox', { name: /Name des Inserats/i }).fill(title)
  await dialog.getByRole('combobox', { name: /Fahrzeugkategorie/i }).click()
  await page.getByRole('option', { name: 'Wechselbrücke', exact: true }).click()
  await dialog.getByRole('combobox', { name: /Fahrzeugtyp/i }).click()
  await page.getByRole('option').first().click()
  await dialog.getByRole('button', { name: 'Inserat anlegen' }).click()
  await expect(page).toHaveURL(/\/plattform\/offers\/renting\//)
  await page.getByRole('textbox', { name: 'Name des Inserats' }).fill(`${title} updated`)
  await page.getByRole('textbox', { name: 'Name des Inserats' }).blur()
  await page.getByRole('link', { name: 'Zurück' }).click()
  await expect(page.getByText(`${title} updated`)).toBeVisible()
  await page.getByText(`${title} updated`).click()
  await expect(page.getByRole('textbox', { name: 'Name des Inserats' })).toHaveValue(`${title} updated`)
  await page.getByRole('button', { name: 'Anzahl und Ort hinzufügen' }).click()
  const location = page.getByRole('dialog', { name: 'Standort & Kontakt' })
  await location.getByRole('spinbutton', { name: /Anzahl Fahrzeuge/i }).fill('1')
  await location.getByPlaceholder('Ort oder PLZ eingeben').fill('Berlin')
  await page.getByRole('option', { name: /Berlin, Deutschland/i }).click()
  await location.getByRole('combobox', { name: /Kontakt/i }).click()
  await page.getByRole('option', { name: /Lobot/i }).click()
  await location.getByRole('button', { name: 'Speichern' }).click()
  await expect(location).toBeHidden()
  await page.getByRole('button', { name: /Veröffentlichen/i }).click()
  await expect(page.getByRole('button', { name: 'Zurückziehen' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ansehen' })).toBeVisible()
})

test('supplier lead report shows deterministic September totals', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Abrechnung' }).click()
  await page.locator('a[href="/plattform/billing/lead-report"]').click()
  await rejectCookies(page)
  await page.getByLabel('Von').fill('2026-09')
  await page.getByLabel('Bis').fill('2026-09')
  const table = page.getByRole('table')
  await expect(table).toContainText('LKW')
  await expect(table).toContainText('25,00 €')
  await expect(table).toContainText('50,00 €')
  await expect(table.getByRole('row', { name: /Gesamtsumme/ })).toContainText('50,00 €')
})

test('each selling supplier sees only its own sale leads', async ({ page, browser }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Kundenanfragen' }).click()
  await page.getByRole('tab', { name: 'Kauf-Anfragen' }).click()
  await page.getByRole('button', { name: /Chewbacca Wookiee Logistics UG/ }).click()
  await expect(page.getByRole('link', { name: 'chewie@kashyyyk.test' })).toBeVisible()
  // The other selling supplier's lead must never appear here.
  await expect(page.getByText('Rodian Haulage GmbH')).toHaveCount(0)

  // A second browser context: the same tab for a different selling supplier.
  const mosEisley = await browser.newContext()
  const other = await mosEisley.newPage()
  await signIn(other, 'supplier@mos-eisley.test')
  await other.getByRole('link', { name: 'Kundenanfragen' }).click()
  await other.getByRole('tab', { name: 'Kauf-Anfragen' }).click()
  await expect(other.getByRole('button', { name: /Greedo Rodian Rodian Haulage GmbH/ })).toBeVisible()
  await expect(other.getByText('Wookiee Logistics UG')).toHaveCount(0)
  await mosEisley.close()
})

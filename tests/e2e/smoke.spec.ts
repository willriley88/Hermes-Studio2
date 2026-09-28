import { test, expect } from '@playwright/test'

test.describe('Hermes Studio smoke tests', () => {
  test('homepage loads and shows app shell', async ({ page }) => {
    await page.goto('/')
    // The app shell should render — look for the sidebar or main nav
    await expect(page.locator('body')).toBeVisible()
    // Should not be a blank page or crash screen
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test('/api/auth-check returns a JSON response', async ({ request }) => {
    const res = await request.get('/api/auth-check')
    // Should always return JSON: 200/401/403 depending on auth config,
    // or 503 when the Hermes agent is unreachable (as in CI)
    expect([200, 401, 403, 503]).toContain(res.status())
    const ct = res.headers()['content-type'] ?? ''
    expect(ct).toContain('application/json')
  })

  test('/api/ping responds (gateway may be offline in CI)', async ({ request }) => {
    const res = await request.get('/api/ping')
    // 200 = gateway connected, 503 = gateway offline — both are valid server responses
    expect([200, 503]).toContain(res.status())
    const ct = res.headers()['content-type'] ?? ''
    expect(ct).toContain('application/json')
  })

  test('chat page renders without crashing', async ({ page }) => {
    await page.goto('/chat')
    await expect(page.locator('body')).toBeVisible()
    // Wait for hydration — no unhandled React error boundary
    await page.waitForTimeout(1000)
    const errorBoundary = page.locator('text=Something went wrong')
    await expect(errorBoundary).not.toBeVisible()
  })

  test('crews page renders without crashing', async ({ page }) => {
    await page.goto('/crews')
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(1000)
    const errorBoundary = page.locator('text=Something went wrong')
    await expect(errorBoundary).not.toBeVisible()
  })

  test('audit trail page renders without crashing', async ({ page }) => {
    await page.goto('/audit')
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(1000)
    const errorBoundary = page.locator('text=Something went wrong')
    await expect(errorBoundary).not.toBeVisible()
  })
})

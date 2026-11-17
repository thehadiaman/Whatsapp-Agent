import { DEMO_DEFAULT_PASSWORD } from '@app/shared';
import { test as base, expect, type Page } from '@playwright/test';

// Each test acts as a different client IP, so sign-in rate-limit buckets
// (5 per minute per IP) never collide between tests. In production the
// reverse proxy sets this header; clients cannot.
export const test = base.extend({
  context: async ({ context }, use) => {
    const n = () => Math.floor(Math.random() * 250) + 1;
    await context.setExtraHTTPHeaders({ 'x-real-ip': `10.${n()}.${n()}.${n()}` });
    await use(context);
  },
});

export { expect };

export const PASSWORD = process.env['SEED_PASSWORD'] ?? DEMO_DEFAULT_PASSWORD;

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

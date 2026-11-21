import { DEMO_CUSTOMERS } from '@app/shared';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, signIn, test } from '../e2e/fixtures';

// Screenshots for the README, written to docs/images/. Customers write in
// through the simulator, the mock assistant answers, and each screen is
// captured as a person would see it. Run by scripts/readme-screenshots.sh.

const SIMULATOR = 'http://127.0.0.1:4010';
const OUT = '../../docs/images';
function customer(name: string) {
  const found = DEMO_CUSTOMERS.find((c) => c.name === name);
  if (!found) throw new Error(`No demo customer named ${name}`);
  return found;
}

async function outbound(request: APIRequestContext, bsuid: string): Promise<number> {
  const response = await request.get(`${SIMULATOR}/control/threads/${bsuid}`);
  const messages = (await response.json()) as { direction: string }[];
  return messages.filter((m) => m.direction === 'out').length;
}

async function send(
  request: APIRequestContext,
  data: { customerId: string; text: string; type?: string; language?: string },
) {
  const bsuid = data.customerId;
  const before = await outbound(request, bsuid);
  expect((await request.post(`${SIMULATOR}/control/messages`, { data })).status()).toBe(202);
  // The reply has reached the customer's phone.
  await expect.poll(() => outbound(request, bsuid), { timeout: 20_000 }).toBeGreaterThan(before);
}

async function open(page: Page, name: string) {
  await page
    .getByLabel('Conversations', { exact: true })
    .getByRole('button', { name: new RegExp(`^\\d+ ${name},`) })
    .click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('README: a grounded reply and its receipt', async ({ page, request }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop shot');
  const rafi = customer('Mohammed Rafi');
  await send(request, { customerId: rafi.bsuid, text: 'Do you repair screens?' });
  await signIn(page, 'priya@qamar.example');
  await open(page, 'Mohammed Rafi');
  await page.keyboard.press('e');
  await expect(
    page.getByRole('region', { name: /Explain this reply/ }).getByText('Tokens, estimated'),
  ).toBeVisible();
  await page.screenshot({ path: `${OUT}/inbox-receipt.png` });
});

test('README: a voice note, transcribed, answered', async ({ page, request }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop shot');
  const sneha = customer('Sneha Kurian');
  await send(request, {
    customerId: sneha.bsuid,
    type: 'audio',
    text: 'Can I order an eggless cake for Saturday?',
    language: 'en',
  });
  await signIn(page, 'mariam@kayal.example');
  await open(page, 'Sneha Kurian');
  await expect(page.getByText('Can I order an eggless cake for Saturday?')).toBeVisible();
  await page.screenshot({ path: `${OUT}/voice.png` });
});

test('README: analytics from the seeded month', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop shot');
  await signIn(page, 'anil@qamar.example');
  await expect(page).toHaveURL(/\/inbox/);
  await page.goto('/analytics');
  await expect(page.getByText(/^The assistant resolved/)).toBeVisible();
  await page.screenshot({ path: `${OUT}/analytics.png`, fullPage: true });
});

test('README: the inbox on a phone', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'mobile shot');
  await signIn(page, 'priya@qamar.example');
  await open(page, 'Fatima Al Mansoori');
  await page.screenshot({ path: `${OUT}/thread-mobile.png` });
});

test('README: the simulator, playing the customers', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop shot');
  await page.goto(SIMULATOR);
  await page.getByText('Mohammed Rafi', { exact: true }).click();
  await expect(page.getByText('Do you repair screens?')).toBeVisible();
  await page.screenshot({ path: `${OUT}/simulator.png` });
});

// The README's two-minute demo, step by step, so its promises stay true.
test('README: the demo script works on a fresh seed', async ({ page, request }) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop only');
  const aisha = customer('Aisha Siddiqui');
  const rafi = customer('Mohammed Rafi');
  await signIn(page, 'priya@qamar.example');
  const heldBy = page.getByTestId('held-by');

  // Asking for a person in Hinglish moves the conversation to the queue.
  await send(request, { customerId: aisha.bsuid, text: 'mujhe kisi insaan se baat karni hai' });
  await open(page, 'Aisha Siddiqui');
  await expect(page.getByText(/Customer asked for a person/).last()).toBeVisible();

  // T takes over; the reply reaches the phone; a note does not.
  await page.keyboard.press('t');
  await expect(heldBy).toContainText('You');
  await page
    .getByRole('textbox', { name: 'Reply to Aisha Siddiqui' })
    .fill('जी, मैं प्रिया हूँ। बताइए?');
  await page.keyboard.press('Enter');
  await expect(page.getByText('जी, मैं प्रिया हूँ। बताइए?')).toBeVisible();
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await page.getByRole('textbox', { name: 'Internal note' }).fill('Wants to swap a charger.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('not sent to the customer').last()).toBeVisible();

  // Hand back to the assistant.
  await page.getByRole('button', { name: /^Hand back to assistant/ }).click();
  await expect(heldBy).toContainText('Assistant');

  // An escalation word goes to a person before the model runs.
  await send(request, { customerId: rafi.bsuid, text: 'I want a refund' });
  await open(page, 'Mohammed Rafi');
  await expect(page.getByText(/Mentioned "refund" \(escalation rule\)/).last()).toBeVisible();
});

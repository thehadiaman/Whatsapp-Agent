import { DEMO_CUSTOMERS } from '@app/shared';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, openAs, signIn, test } from './fixtures';

// The whole loop in mock mode: a customer writes in the simulator, the message
// reaches the inbox live, a person takes over and replies, and the reply
// arrives back on the customer's simulated phone.

const SIMULATOR = 'http://127.0.0.1:4010';

function customer(name: string): string {
  const found = DEMO_CUSTOMERS.find((c) => c.name === name);
  if (!found) throw new Error(`no demo customer ${name}`);
  return found.bsuid;
}

interface SimulatedMessage {
  direction: 'in' | 'out';
  type: string;
  text: string | null;
  status: string | null;
}

async function customerWrites(request: APIRequestContext, name: string, text: string) {
  const response = await request.post(`${SIMULATOR}/control/messages`, {
    data: { customerId: customer(name), text },
  });
  expect(response.status()).toBe(202);
}

async function phoneOf(request: APIRequestContext, name: string): Promise<SimulatedMessage[]> {
  const response = await request.get(`${SIMULATOR}/control/threads/${customer(name)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as SimulatedMessage[];
}

const queue = (page: Page) => page.getByLabel('Conversations', { exact: true });
const row = (page: Page, name: string) =>
  queue(page).getByRole('button', { name: new RegExp(`^\\d+ ${name},`) });
const heldBy = (page: Page) => page.getByTestId('held-by');

/** Leaves a conversation with the assistant if an earlier, failed run left it held. */
async function ensureWithAssistant(page: Page): Promise<void> {
  const handBack = page.getByRole('button', { name: /^Hand back to assistant/ });
  if (await handBack.isVisible()) {
    await handBack.click();
    await expect(heldBy(page)).toContainText('Assistant');
  }
}

test.describe('inbox at the counter', () => {
  test.beforeEach(() => {
    // Behaviour is the same at both widths; it runs once, at desktop width.
    // Mobile layout has its own test and screenshots below.
    test.skip(test.info().project.name !== 'desktop', 'runs at desktop width');
  });

  test('a customer message arrives live; take over, reply, note, hand back', async ({
    page,
    request,
  }) => {
    await signIn(page, 'priya@qamar.example');
    await expect(page.locator('header').getByText('Live', { exact: true })).toBeVisible();

    // Waiting customers are always at the top of the queue.
    await expect(queue(page).getByRole('heading').first()).toHaveText(/^Waiting for a person/);

    const question = `Is the Pixel 9 Pro in stock in Deira? (${String(Date.now())})`;
    await customerWrites(request, 'Mohammed Rafi', question);
    // No reload: the socket says the conversation changed and the list refetches.
    await expect(queue(page).getByText(question)).toBeVisible();

    await row(page, 'Mohammed Rafi').click();
    const thread = page.getByRole('list', { name: 'Conversation with Mohammed Rafi' });
    await expect(thread.getByText(question)).toBeVisible();
    await ensureWithAssistant(page);

    // Keyboard first: T takes over and puts the cursor in the reply box.
    await page.keyboard.press('t');
    await expect(heldBy(page)).toContainText('You');
    await expect(row(page, 'Mohammed Rafi')).toHaveAccessibleName(/held by you$/);
    const composer = page.getByRole('textbox', { name: 'Reply to Mohammed Rafi' });
    await expect(composer).toBeFocused();

    const reply = `Yes, two in stock at Deira. Shall I hold one? (${String(Date.now())})`;
    await composer.fill(reply);
    await page.keyboard.press('Enter');
    await expect(thread.getByText(reply)).toBeVisible();

    // It reaches the customer's phone, and the delivery receipt comes back.
    await expect
      .poll(async () => (await phoneOf(request, 'Mohammed Rafi')).find((m) => m.text === reply))
      .toMatchObject({ direction: 'out', type: 'text' });
    await expect(thread.locator('li', { hasText: reply })).toContainText(/delivered|read/);

    // An internal note stays inside the business.
    const note = `Customer prefers pickup after 6 pm (${String(Date.now())})`;
    await page.getByRole('button', { name: 'Add internal note' }).click();
    await page.getByRole('textbox', { name: 'Internal note' }).fill(note);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(thread.getByText(note)).toBeVisible();
    await expect(thread.locator('li', { hasText: note })).toContainText('not sent to the customer');
    expect((await phoneOf(request, 'Mohammed Rafi')).some((m) => m.text === note)).toBe(false);

    await page.getByRole('button', { name: /^Hand back to assistant/ }).click();
    await expect(heldBy(page)).toContainText('Assistant');
    await expect(
      thread.getByText(/Handed back to the assistant by Priya Raman/).last(),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Reply to Mohammed Rafi' })).toHaveCount(0);
  });

  test('a colleague sees custody change without reloading', async ({ page, browser }) => {
    const owner = await openAs(browser, 'anil@qamar.example');
    try {
      await signIn(page, 'priya@qamar.example');
      await row(page, 'Aisha Siddiqui').click();
      await ensureWithAssistant(page);
      await expect(
        queue(owner.page).getByRole('region', { name: 'Assistant' }).getByText('Aisha Siddiqui'),
      ).toBeVisible();

      // The header button; the composer offers the same action.
      await page
        .getByRole('button', { name: /^Take over/ })
        .first()
        .click();
      await expect(heldBy(page)).toContainText('You');
      // Anil's list moves Aisha to Colleagues, stamped with Priya's initials.
      const colleagues = queue(owner.page).getByRole('region', { name: 'Colleagues' });
      await expect(colleagues.getByText('Aisha Siddiqui')).toBeVisible();
      await expect(row(owner.page, 'Aisha Siddiqui')).toContainText('PR');

      await page.getByRole('button', { name: /^Hand back to assistant/ }).click();
      await expect(
        queue(owner.page).getByRole('region', { name: 'Assistant' }).getByText('Aisha Siddiqui'),
      ).toBeVisible();
    } finally {
      await owner.close();
    }
  });

  test('outside the 24-hour window only the approved template can be sent', async ({
    page,
    request,
  }) => {
    await signIn(page, 'nikhil@kayal.example');
    await row(page, 'Joseph Mathew').click();
    await expect(page.getByTestId('window')).toContainText('Reply window closed');
    await expect(row(page, 'Joseph Mathew')).toContainText('window closed');
    await expect(page.getByRole('textbox', { name: 'Reply to Joseph Mathew' })).toHaveCount(0);

    const before = (await phoneOf(request, 'Joseph Mathew')).length;
    await page.getByRole('button', { name: /^Send template/ }).click();
    await expect
      .poll(async () => (await phoneOf(request, 'Joseph Mathew')).slice(before))
      .toContainEqual(expect.objectContaining({ direction: 'out', type: 'template' }));
  });

  test("one business never sees another business's conversations", async ({ page, browser }) => {
    const kayal = await openAs(browser, 'nikhil@kayal.example');
    let kayalId: string;
    try {
      const response = await kayal.page.request.get('/api/conversations?scope=open');
      expect(response.ok()).toBe(true);
      const list = (await response.json()) as { id: string; customer: { name: string | null } }[];
      const joseph = list.find((c) => c.customer.name === 'Joseph Mathew');
      if (!joseph) throw new Error('seeded Kayal conversation missing');
      kayalId = joseph.id;
    } finally {
      await kayal.close();
    }

    await signIn(page, 'priya@qamar.example');
    await expect(row(page, 'Fatima Al Mansoori')).toBeVisible();
    await expect(queue(page).getByText('Joseph Mathew')).toHaveCount(0);

    // Through the API and through a shared link: row-level security hides it.
    expect((await page.request.get(`/api/conversations/${kayalId}`)).status()).toBe(404);
    // With the app's Origin, so the CSRF check passes and the tenant check answers.
    const origin = new URL(page.url()).origin;
    expect(
      (
        await page.request.post(`/api/conversations/${kayalId}/take-over`, {
          data: {},
          headers: { origin },
        })
      ).status(),
    ).toBe(404);
    await page.goto(`/inbox?c=${kayalId}`);
    await expect(
      page.getByRole('alert').filter({ hasText: "This conversation isn't in your inbox" }),
    ).toBeVisible();
  });
});

test('at 390 px the list and the thread take turns', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'mobile layout only');
  await signIn(page, 'priya@qamar.example');
  await row(page, 'Fatima Al Mansoori').click();
  await expect(page.getByRole('heading', { name: 'Fatima Al Mansoori' })).toBeVisible();
  await expect(queue(page)).toBeHidden();

  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByLabel('Details', { exact: true })).toContainText('+971 50 000 0101');
  await page.getByRole('button', { name: 'Close details' }).click();

  await page.getByRole('button', { name: '‹ Inbox' }).click();
  await expect(queue(page)).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

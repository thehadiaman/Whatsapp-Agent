import { DEMO_CUSTOMERS } from '@app/shared';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, openAs, signIn, test } from './fixtures';

const SIMULATOR = 'http://127.0.0.1:4010';
const sneha = DEMO_CUSTOMERS.find((c) => c.name === 'Sneha Kurian')!;

interface PhoneMessage {
  direction: string;
  type: string;
  text: string | null;
}

async function phone(request: APIRequestContext): Promise<PhoneMessage[]> {
  const response = await request.get(`${SIMULATOR}/control/threads/${sneha.bsuid}`);
  return (await response.json()) as PhoneMessage[];
}

async function speak(request: APIRequestContext, text: string, language: string) {
  const sent = await request.post(`${SIMULATOR}/control/messages`, {
    data: { customerId: sneha.bsuid, type: 'audio', text, language },
  });
  expect(sent.status()).toBe(202);
}

/** Opens Sneha's conversation with the assistant holding it (earlier runs may have taken over). */
async function openSneha(page: Page) {
  await signIn(page, 'nikhil@kayal.example');
  await page
    .getByLabel('Conversations', { exact: true })
    .getByRole('button', { name: /^\d+ Sneha Kurian,/ })
    .click();
  const handBack = page.getByRole('button', { name: /^Hand back to assistant/ });
  if (await handBack.isVisible()) await handBack.click();
  await expect(page.getByTestId('held-by')).toContainText('Assistant');
  return page.getByRole('list', { name: 'Conversation with Sneha Kurian' });
}

test.describe('voice notes', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'desktop', 'runs at desktop width');
  });

  test('a customer voice note is transcribed and answered with a voice note', async ({
    page,
    request,
  }) => {
    const thread = await openSneha(page);
    const spokenBefore = (await phone(request)).filter(
      (m) => m.direction === 'out' && m.type === 'audio',
    ).length;

    // A word no earlier run used, so this run's lines can be told apart.
    const token = `v${Date.now().toString(36)}`;
    await speak(request, `Do you have eggless cakes? ${token}`, 'en');

    const note = thread.getByRole('listitem').filter({ hasText: token });
    await expect(note.getByText('Transcript from simulator')).toBeVisible();
    // The length is known before playing; the player plays it.
    await expect(note.getByText('0:00 / 0:01')).toBeVisible();
    await note.getByRole('button', { name: 'Play voice note from the customer' }).click();
    await expect(
      note.getByRole('button', { name: 'Pause voice note from the customer' }),
    ).toBeVisible();

    // The assistant answers in kind: the customer hears a voice note that says it.
    await expect
      .poll(
        async () =>
          (await phone(request)).filter((m) => m.direction === 'out' && m.type === 'audio').length,
        { timeout: 15_000 },
      )
      .toBe(spokenBefore + 1);
    const reply = thread.getByRole('listitem').last();
    await expect(reply.getByText(/Sent as voice · mock voice/)).toBeVisible();
    await expect(reply.getByText(/every cake on the menu can be made eggless/)).toBeVisible();
    await expect(reply.getByRole('button', { name: 'Play voice reply' })).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/voice-desktop.png' });
  });

  test('a Malayalam voice note is answered in text: there is no Malayalam voice', async ({
    page,
    request,
  }) => {
    const thread = await openSneha(page);
    const token = `m${Date.now().toString(36)}`;
    // "Is there egg in this cake?"
    await speak(request, `ഈ കേക്കിൽ മുട്ട ഉണ്ടോ? ${token}`, 'ml');
    const note = thread.getByRole('listitem').filter({ hasText: token });
    await expect(note.getByText(/^ml · Transcript from simulator$/)).toBeVisible();
    await expect(thread.getByRole('listitem').last()).toContainText(
      'Sent as text: no voice for Malayalam',
      { timeout: 15_000 },
    );
  });

  test('a person can reply with a voice note', async ({ page, request }) => {
    const thread = await openSneha(page);
    // A fresh message keeps the 24-hour window open.
    await speak(request, `Is the order ready? t${Date.now().toString(36)}`, 'en');
    await expect(thread.getByRole('listitem').last()).toContainText('Sent as voice', {
      timeout: 15_000,
    });
    const before = (await phone(request)).length;

    // The header button; the composer offers the same action.
    await page
      .getByRole('button', { name: /^Take over/ })
      .first()
      .click();
    await expect(page.getByTestId('held-by')).toContainText('You');
    const toggle = page.getByRole('button', { name: 'Voice reply: off' });
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Voice reply: on' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const words = `Your cake is ready for pickup. ${Date.now().toString(36)}`;
    await page.getByLabel('Reply to Sneha Kurian').fill(words);
    await page.getByRole('button', { name: 'Send as voice' }).click();

    const line = thread.getByRole('listitem').filter({ hasText: words });
    await expect(line.getByText(/Sent as voice/)).toBeVisible();
    await expect.poll(async () => (await phone(request)).length).toBe(before + 1);
    expect((await phone(request)).at(-1)).toMatchObject({ type: 'audio', text: words });

    await page.getByRole('button', { name: /^Hand back to assistant/ }).click();
  });
});

test('screenshots: voice notes', async ({ browser }, info) => {
  const desk = await openAs(browser, 'nikhil@kayal.example');
  try {
    await desk.page
      .getByLabel('Conversations', { exact: true })
      .getByRole('button', { name: /^\d+ Sneha Kurian,/ })
      .click();
    await expect(desk.page.getByText('Transcript from simulator').last()).toBeVisible();
    await desk.page.screenshot({ path: `e2e/screenshots/voice-thread-${info.project.name}.png` });
  } finally {
    await desk.close();
  }
});

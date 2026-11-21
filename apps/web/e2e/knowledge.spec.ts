import { fileURLToPath } from 'node:url';
import { DEMO_CUSTOMERS } from '@app/shared';
import type { Page } from '@playwright/test';
import { expect, openAs, signIn, test } from './fixtures';

const SIMULATOR = 'http://127.0.0.1:4010';
const PDF = fileURLToPath(
  new URL('../../../packages/pipeline/test/fixtures/warranty.pdf', import.meta.url),
);

const sources = (page: Page) => page.getByLabel('Knowledge sources', { exact: true });

async function tryQuestion(page: Page, question: string) {
  await page.getByLabel('Question', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Try it' }).click();
}

test.describe('the knowledge base', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'desktop', 'runs at desktop width');
  });

  test('an owner adds an FAQ; once read, the assistant would use it', async ({ page }) => {
    await signIn(page, 'anil@qamar.example');
    await page.getByRole('link', { name: 'Knowledge' }).click();
    await expect(sources(page).getByText('Price list November.csv')).toBeVisible();

    // A word no earlier run used: repeated runs leave their FAQs behind, and
    // the keyword half of retrieval must single this one out.
    const token = `refurb${Date.now().toString(36)}`;
    const question = `Do you sell refurbished phones (${token})?`;
    await page.getByRole('button', { name: 'Add source ▾' }).click();
    await page.getByRole('menuitem', { name: 'Add an FAQ' }).click();
    await page.getByLabel('Question', { exact: true }).fill(question);
    await page.getByLabel('Answer', { exact: true }).fill('Yes, with a 6-month shop warranty.');
    await page.getByRole('button', { name: 'Save FAQ' }).click();

    // The worker reads it; the page follows the status without a reload.
    await expect(page.getByRole('heading', { name: question })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Ready · 1 passage', { timeout: 15_000 });

    await tryQuestion(page, `refurbished phones ${token}`);
    await expect(page.getByText('The assistant would read:')).toBeVisible();
    await expect(page.getByRole('button', { name: question })).toBeVisible();
  });

  test('an owner uploads a PDF and sees it read page by page', async ({ page }) => {
    await signIn(page, 'anil@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.goto('/knowledge');
    await page.getByLabel('Upload a file', { exact: true }).setInputFiles(PDF);
    await expect(page.getByRole('heading', { name: 'warranty.pdf' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(/^Ready · \d+ passages?$/, {
      timeout: 15_000,
    });
    await expect(page.getByText(/2 pages/).first()).toBeVisible();
    await expect(
      page.getByText('Screen guards and cases are not covered by the warranty.'),
    ).toBeVisible();
  });

  test('an agent can try questions but not change the knowledge base', async ({ page }) => {
    await signIn(page, 'priya@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.goto('/knowledge');
    await expect(sources(page).getByText('Price list November.csv')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add source ▾' })).toHaveCount(0);
    await tryQuestion(page, 'bhai screen guard ka warranty kitna hai');
    await expect(
      page.getByRole('button', { name: 'Is the screen guard covered by warranty?' }),
    ).toBeVisible();
  });
});

test('a customer question is answered from the knowledge base, with a receipt', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'runs at desktop width');
  const customer = DEMO_CUSTOMERS.find((c) => c.name === 'Mohammed Rafi')!;
  await signIn(page, 'priya@qamar.example');
  const thread = page.getByRole('list', { name: 'Conversation with Mohammed Rafi' });

  // Hand back first if an earlier run left it with a person.
  await page
    .getByLabel('Conversations', { exact: true })
    .getByRole('button', { name: /^\d+ Mohammed Rafi,/ })
    .click();
  const handBack = page.getByRole('button', { name: /^Hand back to assistant/ });
  // The thread must have loaded before its buttons say who holds it.
  await expect(page.getByTestId('held-by')).toBeVisible();
  if (await handBack.isVisible()) await handBack.click();
  await expect(page.getByTestId('held-by')).toContainText('Assistant');

  const answer = 'Yes, for Samsung, Apple and Google phones.';
  const answers = thread.getByText(new RegExp(answer.replace(/[.]/g, '\\.')));
  const phoneAnswers = async () => {
    const response = await request.get(`${SIMULATOR}/control/threads/${customer.bsuid}`);
    const messages = (await response.json()) as { direction: string; text: string | null }[];
    return messages.filter((m) => m.direction === 'out' && m.text?.startsWith(answer)).length;
  };
  // Earlier runs leave their answers in the thread: count, then expect one more.
  const before = await answers.count();
  const onPhoneBefore = await phoneAnswers();

  const question = `Do you repair screens? (${String(Date.now())})`;
  const sent = await request.post(`${SIMULATOR}/control/messages`, {
    data: { customerId: customer.bsuid, text: question },
  });
  expect(sent.status()).toBe(202);

  await expect(thread.getByText(question)).toBeVisible();
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  await expect.poll(phoneAnswers).toBe(onPhoneBefore + 1);

  // E explains the latest reply: an itemised receipt in the context pane.
  await page.keyboard.press('e');
  const receipt = page.getByRole('region', { name: /Explain this reply/ });
  await expect(receipt.getByText('Answered from the knowledge base.')).toBeVisible();
  await expect(receipt.getByRole('link', { name: 'Do you repair screens?' })).toBeVisible();
  await expect(receipt.getByText('Tokens, estimated')).toBeVisible();
  await expect(receipt.getByText('$0 · mock model')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/receipt-desktop.png' });
});

test('screenshots: knowledge base', async ({ browser }, info) => {
  const desk = await openAs(browser, 'anil@qamar.example');
  try {
    await desk.page.goto('/knowledge');
    await expect(sources(desk.page).getByText('Price list November.csv')).toBeVisible();
    await desk.page.screenshot({ path: `e2e/screenshots/knowledge-${info.project.name}.png` });
    await sources(desk.page).getByText('Price list November.csv').click();
    await expect(desk.page.getByRole('heading', { name: 'Price list November.csv' })).toBeVisible();
    await tryQuestion(desk.page, 'how much is the galaxy s24');
    await expect(desk.page.getByText('The assistant would read:')).toBeVisible();
    await desk.page.screenshot({
      path: `e2e/screenshots/knowledge-source-${info.project.name}.png`,
    });
  } finally {
    await desk.close();
  }
});

test('at 390 px the section menu switches to Knowledge, and source and list take turns', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'mobile', 'mobile layout only');
  await signIn(page, 'anil@qamar.example');
  await expect(page).toHaveURL(/\/inbox/);
  await page.getByRole('button', { name: 'Sections' }).click();
  await page.getByRole('menuitem', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(/\/knowledge/);
  await sources(page).getByText('Price list November.csv').click();
  await expect(page.getByRole('heading', { name: 'Price list November.csv' })).toBeVisible();
  await expect(sources(page)).toBeHidden();
  await page.getByRole('button', { name: '‹ Knowledge' }).click();
  await expect(sources(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

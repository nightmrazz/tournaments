import { expect, test, type Page } from '@playwright/test';

// Full organizer + player journey in local mode: create → register → draw → results →
// standings → knockout → final → champion. Uses 8 players in 2 groups so it runs quickly.

async function playAllOpenMatches(page: Page) {
  await page.getByLabel('Status').selectOption('open');
  for (let i = 0; i < 40; i++) {
    const edit = page.getByRole('button', { name: /^Edit match/ }).and(page.locator(':enabled')).first();
    if (!(await edit.count())) return;
    await edit.click();
    const dialog = page.getByRole('dialog');
    const boxes = dialog.getByRole('textbox');
    await boxes.nth(0).fill(String(2 + (i % 3)));
    await boxes.nth(1).fill('1');
    await dialog.getByRole('button', { name: 'Save final score' }).click();
    await expect(dialog).toBeHidden();
  }
  throw new Error('Too many matches');
}

test('organizer runs a complete tournament', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());

  // 1. Create the tournament.
  await page.goto('/admin/tournaments/new');
  await page.getByLabel('Tournament name').fill('E2E Spring Cup');
  await page.getByLabel('Maximum participants').fill('8');
  await expect(page.getByText('Until then the plan for 8 players is 2 groups, top 2 advance.')).toBeVisible();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Spring Cup' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish & open registration' }).click();
  await expect(page.getByText('Registration open').first()).toBeVisible();

  // 2. Players register on the public page.
  await page.getByRole('link', { name: 'Public page' }).click();
  for (let i = 1; i <= 8; i++) {
    await page.getByLabel('Display name').fill(`Player ${i}`);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByText(`Player ${i} is registered`).first()).toBeVisible();
  }
  // The form closes once capacity is reached.
  await expect(page.getByText('This tournament is full.')).toBeVisible();

  // 3. Close registration, draw groups, generate fixtures.
  await page.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Close registration' }).click();
  await page.getByRole('button', { name: 'Preview draw' }).click();
  await expect(page.getByTestId('draw-preview')).toContainText('Group B');
  await page.getByRole('button', { name: 'Confirm draw and generate fixtures' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText('Groups and fixtures created')).toBeVisible();

  // 4. Record every group result.
  await page.getByRole('tab', { name: /Matches/ }).click();
  await expect(page.getByTestId('match-card')).toHaveCount(12);
  await playAllOpenMatches(page);

  // 5. Standings reflect the results.
  await page.getByRole('link', { name: 'Public page' }).click();
  await page.getByRole('tab', { name: 'Standings' }).click();
  await expect(page.getByText('Final', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('table').first().getByRole('row')).toHaveCount(5);

  // 6. Generate the knockout bracket.
  await page.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: 'Stage control' }).click();
  await page.getByRole('button', { name: 'Generate knockout bracket' }).click();
  await expect(page.getByText('Knockout bracket generated')).toBeVisible();

  // 7. Play semi-finals, third-place match and final.
  await page.getByRole('tab', { name: /Matches/ }).click();
  await playAllOpenMatches(page);

  // 8. Champion is shown; the tournament can be completed.
  await page.getByRole('button', { name: 'Mark completed' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark completed' }).click();
  await expect(page.getByText('Completed').first()).toBeVisible();
  await page.getByRole('link', { name: 'Public page' }).click();
  await expect(page.getByTestId('champion-banner')).toBeVisible();
  await page.getByRole('tab', { name: 'Playoffs' }).click();
  await expect(page.getByRole('region', { name: 'Knockout bracket' })).toContainText('Final');
});

test('registration validation and duplicate prevention', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/admin/tournaments/new');
  await page.getByLabel('Tournament name').fill('Validation Cup');
  await page.getByLabel('Format', { exact: true }).selectOption('single_elimination');
  await page.getByLabel('Maximum participants').fill('4');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Publish & open registration' }).click();
  await page.getByRole('link', { name: 'Public page' }).click();

  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('At least 2 characters').first()).toBeVisible();

  await page.getByLabel('Display name').fill('Alpha');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Alpha is registered').first()).toBeVisible();

  await page.getByLabel('Display name').fill('  alpha ');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('This name is already registered.')).toBeVisible();
});

test('organizer assigns teams after the group draw; interface switches to Russian', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Create demo tournament' }).click();
  await expect(page.getByText('Demo tournament created')).toBeVisible();

  // Before the draw there is no team field.
  await page.getByRole('tab', { name: /Participants/ }).click();
  await expect(page.getByLabel('Team for Demo Player 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('After the draw').first()).toBeVisible();

  // After the draw, Stage control offers the "Assign teams" step, grouped by group.
  await page.getByRole('tab', { name: 'Stage control' }).click();
  await expect(page.getByTestId('team-assignment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview draw' }).click();
  await page.getByRole('button', { name: 'Confirm draw and generate fixtures' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();
  const assign = page.getByTestId('team-assignment');
  await expect(assign).toContainText('Group A');
  await expect(assign).toContainText('Teams assigned: 0/16');
  const team = assign.getByLabel('Team for Demo Player 1', { exact: true });
  await team.fill('Chelsea');
  await team.press('Enter');
  await expect(page.getByText('Demo Player 1 plays as Chelsea.')).toBeVisible();
  await expect(assign).toContainText('Teams assigned: 1/16');

  // The Participants tab can change teams too.
  await page.getByRole('tab', { name: /Participants/ }).click();
  await page.getByLabel('Team for Demo Player 2', { exact: true }).fill('Arsenal');
  await page.getByLabel('Team for Demo Player 2', { exact: true }).press('Enter');
  await expect(page.getByText('Demo Player 2 plays as Arsenal.')).toBeVisible();

  // The public page shows the teams.
  await page.getByRole('link', { name: 'Public page' }).click();
  await page.getByRole('tab', { name: /Participants/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Chelsea');
  await expect(page.getByRole('tabpanel')).toContainText('Arsenal');

  // Switch the interface to Russian; the choice survives a reload.
  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.getByRole('tab', { name: /Участники/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Турниры' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Таблицы' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('tab', { name: 'Standings' })).toBeVisible();
});

test('paid registration: application → receipt → organizer confirms', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/admin/tournaments/new');
  await page.getByLabel('Tournament name').fill('Paid Cup');
  await page.getByLabel('Format', { exact: true }).selectOption('single_elimination');
  await page.getByLabel('Maximum participants').fill('4');
  await page.getByLabel('Require an entry fee').check();
  await page.getByLabel('Entry fee', { exact: true }).fill('7 000 ₸');
  await page.getByLabel('Telegram for receipts').fill('@temcch_org');
  await page.getByLabel('Payment details').fill('Kaspi Gold 4400 0000 0000 0000');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Publish & open registration' }).click();
  await page.getByRole('link', { name: 'Public page' }).click();

  // The player applies and sees the payment instructions with an application ID.
  await page.getByLabel('Display name').fill('Payer');
  await page.getByRole('button', { name: 'Submit application' }).click();
  const card = page.getByTestId('payment-card');
  await expect(card).toContainText('Awaiting payment');
  await expect(card).toContainText('7 000 ₸');
  await expect(card).toContainText('Kaspi Gold 4400 0000 0000 0000');
  await expect(card.getByRole('link', { name: /Send receipt in Telegram/ })).toHaveAttribute('href', 'https://t.me/temcch_org');
  const code = (await card.getByRole('button', { name: /Copy application ID/ }).innerText()).trim();
  expect(code).toMatch(/^[0-9A-F]{8}$/);
  await expect(card).toContainText(`Application ${code} · Paid Cup · Payer`);

  // Not a participant yet.
  await page.getByRole('tab', { name: /Participants/ }).click();
  await expect(page.getByText('No participants yet')).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();

  await card.getByRole('button', { name: 'I paid and sent the receipt' }).click();
  await expect(card).toContainText('Awaiting receipt check');

  // The organizer finds the application by its ID and confirms it.
  await page.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: /Participants/ }).click();
  const apps = page.getByTestId('applications');
  await expect(apps).toContainText(`ID ${code}`);
  await apps.getByRole('button', { name: 'Confirm payment: Payer' }).click();
  await expect(page.getByText('Payer is confirmed as a participant.')).toBeVisible();

  // The player sees the confirmed status and is now listed publicly.
  await page.goto('/profile');
  await expect(page.getByTestId('payment-card')).toContainText('Registration confirmed');
  await page.getByRole('link', { name: 'Paid Cup' }).click();
  await page.getByRole('tab', { name: /Participants/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Payer');
});

test('waitlist, cancellation, offering the freed place, pausing and finalizing the roster', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/admin/tournaments/new');
  await page.getByLabel('Tournament name').fill('Waitlist Cup');
  await page.getByLabel('Format', { exact: true }).selectOption('single_elimination');
  await page.getByLabel('Maximum participants').fill('2');
  await page.getByLabel('Minimum players').fill('2');
  await page.getByRole('checkbox', { name: /^Waitlist/ }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('button', { name: 'Publish & open registration' }).click();

  // Pausing stops new registrations without losing anything.
  await page.getByRole('button', { name: 'Pause registration' }).click();
  await expect(page.getByText('Registration is paused.')).toBeVisible();
  await page.getByRole('link', { name: 'Public page' }).click();
  await expect(page.getByText('Registration is paused by the organizer.').first()).toBeVisible();
  await page.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Resume registration' }).click();
  await page.getByRole('link', { name: 'Public page' }).click();

  // Two places, three players: the third one joins the waitlist.
  for (const name of ['Anna', 'Bek']) {
    await page.getByLabel('Display name').fill(name);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByText(`${name} is registered.`).first()).toBeVisible();
  }
  await expect(page.getByTestId('places-left')).toContainText('free places: 0 of 2');
  await page.getByLabel('Display name').fill('Cara');
  await page.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(page.getByText('All places are taken — Cara was added to the waitlist.').first()).toBeVisible();
  const cara = page.getByTestId('payment-card').filter({ hasText: 'Waitlist' });
  await expect(cara).toContainText('Waitlist — position 1');

  // Anna withdraws; the organizer offers the free place to Cara.
  const anna = page.getByTestId('payment-card').filter({ hasText: 'Anna' });
  await expect(anna).toContainText('Registration confirmed');
  await anna.getByRole('button', { name: 'Cancel my registration' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel registration' }).click();
  await expect(page.getByText('Your registration was cancelled.')).toBeVisible();

  await page.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: /Participants/ }).click();
  await expect(page.getByTestId('registration-stats')).toContainText('1/2');
  await page.getByRole('tab', { name: /Waitlisted/ }).click();
  await page.getByRole('button', { name: 'Confirm: Cara' }).click();
  await expect(page.getByText('Cara is confirmed as a participant.')).toBeVisible();
  await expect(page.getByTestId('registration-stats')).toContainText('2/2');

  // Finalize: close registration, check the roster and generate the bracket after confirmation.
  await page.getByRole('button', { name: 'Close registration' }).click();
  await page.getByRole('tab', { name: 'Stage control' }).click();
  const roster = page.getByTestId('roster-finalizer');
  await expect(roster).toContainText('Confirmed participants: 2 of 2');
  await expect(roster).toContainText('Fits 2 confirmed participants.');
  await page.getByRole('button', { name: 'Preview bracket' }).click();
  await page.getByRole('button', { name: 'Confirm and generate' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Generate fixtures for 2 participants?');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText('Bracket generated. The tournament is now in progress.')).toBeVisible();
  await page.getByRole('link', { name: 'Public page' }).click();
  await page.getByRole('tab', { name: 'Playoffs' }).click();
  await expect(page.getByRole('region', { name: 'Knockout bracket' })).toContainText('Bek');
  await expect(page.getByRole('region', { name: 'Knockout bracket' })).not.toContainText('Anna');
  await expect(page.getByRole('region', { name: 'Knockout bracket' })).toContainText('Cara');
});

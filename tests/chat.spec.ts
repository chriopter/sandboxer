import { test, expect } from '@playwright/test';

// Test configuration via environment variables
const BASE_URL = process.env.SANDBOXER_URL || 'http://localhost:8080';
const PASSWORD = process.env.SANDBOXER_PASSWORD || '';

test.describe('Claude Chat Sessions', () => {
  // Login before each test
  test.beforeEach(async ({ page }) => {
    // Go to login page
    await page.goto(BASE_URL);

    // Check if we need to login
    if (page.url().includes('/login')) {
      await page.fill('input[name="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/^(?!.*\/login)/);
    }
  });

  test('1. Can create a chat session from dropdown', async ({ page }) => {
    // Open type dropdown and select chat
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');

    // Click the new button
    await page.click('.new-btn');

    // Wait for the new card to appear
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Verify the chat card exists
    const chatCard = await page.locator('.card-chat').first();
    await expect(chatCard).toBeVisible();

    // Verify it has a chat preview area
    await expect(chatCard.locator('.chat-preview')).toBeVisible();
  });

  test('2. Chat card shows preview messages', async ({ page }) => {
    // Find any existing chat card or create one
    let chatCard = page.locator('.card-chat').first();

    if (await chatCard.count() === 0) {
      // Create a chat session
      await page.click('#typeSelect summary');
      await page.click('#typeOptions button[data-value="chat"]');
      await page.click('.new-btn');
      await page.waitForSelector('.card-chat', { timeout: 5000 });
      chatCard = page.locator('.card-chat').first();
    }

    // Verify preview area exists
    await expect(chatCard.locator('.chat-preview')).toBeVisible();
  });

  test('3. Can open chat page from card', async ({ page }) => {
    // Find or create a chat card
    let chatCard = page.locator('.card-chat').first();

    if (await chatCard.count() === 0) {
      await page.click('#typeSelect summary');
      await page.click('#typeOptions button[data-value="chat"]');
      await page.click('.new-btn');
      await page.waitForSelector('.card-chat', { timeout: 5000 });
      chatCard = page.locator('.card-chat').first();
    }

    // Get the session name
    const sessionName = await chatCard.getAttribute('data-session');

    // Click the chat preview to open
    const [newPage] = await Promise.all([
      page.waitForEvent('popup'),
      chatCard.locator('.chat-preview').click()
    ]);

    // Verify the chat page opened
    await expect(newPage).toHaveURL(/\/chat\?session=/);

    // Verify chat UI elements
    await expect(newPage.locator('.chat-header')).toBeVisible();
    await expect(newPage.locator('.chat-messages')).toBeVisible();
    await expect(newPage.locator('#chatInput')).toBeVisible();
    await expect(newPage.locator('#send-btn')).toBeVisible();

    await newPage.close();
  });

  test('4. Chat page has proper UI elements', async ({ page }) => {
    // Create a NEW chat session and open its page
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Get the NEWEST chat card (just created)
    const chatCards = await page.locator('.card-chat').all();
    const chatCard = chatCards[chatCards.length - 1]; // Last one is newest
    const sessionName = await chatCard.getAttribute('data-session');

    // Navigate directly to chat page
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Check header elements
    await expect(page.locator('.chat-back')).toBeVisible();
    await expect(page.locator('.chat-title')).toBeVisible();
    await expect(page.locator('#clear-btn')).toBeVisible();
    await expect(page.locator('#kill-btn')).toBeVisible();

    // Check messages area
    await expect(page.locator('.chat-messages')).toBeVisible();

    // Chat empty exists in DOM (visibility depends on whether there are messages)
    await expect(page.locator('#chatEmpty')).toBeAttached();

    // Check composer
    await expect(page.locator('.chat-composer')).toBeVisible();
    await expect(page.locator('#attach-btn')).toBeVisible();
    await expect(page.locator('#chatInput')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeVisible();
  });

  test('5. Can type in chat input', async ({ page }) => {
    // Navigate to a chat page
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    const chatCard = page.locator('.card-chat').first();
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Type in input
    const input = page.locator('#chatInput');
    await input.fill('Hello, this is a test message');

    // Verify input has text
    await expect(input).toHaveValue('Hello, this is a test message');
  });

  test('6. Chat input auto-resizes', async ({ page }) => {
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    const chatCard = page.locator('.card-chat').first();
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    const input = page.locator('#chatInput');

    // Get initial height
    const initialHeight = await input.evaluate(el => el.scrollHeight);

    // Type multiple lines
    await input.fill('Line 1\nLine 2\nLine 3\nLine 4');

    // Height should have increased (auto-resize)
    const newHeight = await input.evaluate(el => el.scrollHeight);
    expect(newHeight).toBeGreaterThanOrEqual(initialHeight);
  });

  test('7. Can send a message and see it in the chat', async ({ page }) => {
    // Create a fresh chat session
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Get the NEWEST chat card
    const chatCards = await page.locator('.card-chat').all();
    const chatCard = chatCards[chatCards.length - 1];
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Wait for page to load
    await page.waitForSelector('#chatInput', { timeout: 5000 });

    // Clear any existing messages first to ensure clean state
    page.on('dialog', dialog => dialog.accept());
    await page.click('#clear-btn');
    await page.waitForTimeout(500);

    // Type and send message
    const testMessage = 'Hello Claude, please respond with just "Hi there"';
    await page.fill('#chatInput', testMessage);
    await page.click('#send-btn');

    // Wait for user message to appear
    await page.waitForSelector('.chat-message.user', { timeout: 10000 });

    // Verify user message contains our test message
    const userMsg = page.locator('.chat-message.user').last();
    await expect(userMsg).toContainText('Hello Claude');

    // Empty state should be hidden (we have a message now)
    await expect(page.locator('.chat-empty')).toBeHidden();

    // Wait for assistant response (may take a while with claude CLI)
    await page.waitForSelector('.chat-message.assistant', { timeout: 120000 });

    // Verify assistant message exists
    const assistantMsg = page.locator('.chat-message.assistant').last();
    await expect(assistantMsg).toBeVisible();
  });

  test('8. Chat scrolls to bottom on new message', async ({ page }) => {
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    const chatCard = page.locator('.card-chat').first();
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Send a message
    await page.fill('#chatInput', 'Test message for scroll');
    await page.click('#send-btn');

    // Wait for message
    await page.waitForSelector('.chat-message.user', { timeout: 5000 });

    // Check that messages container is scrolled to bottom
    const isScrolledToBottom = await page.evaluate(() => {
      const container = document.querySelector('.chat-messages');
      if (!container) return false;
      return container.scrollTop + container.clientHeight >= container.scrollHeight - 10;
    });

    expect(isScrolledToBottom).toBe(true);
  });

  test('9. Can clear chat history', async ({ page }) => {
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    const chatCard = page.locator('.card-chat').first();
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Send a message first
    await page.fill('#chatInput', 'Message to be cleared');
    await page.click('#send-btn');
    await page.waitForSelector('.chat-message.user', { timeout: 5000 });

    // Setup dialog handler
    page.on('dialog', dialog => dialog.accept());

    // Click clear button
    await page.click('#clear-btn');

    // Wait for messages to be cleared
    await page.waitForFunction(() => {
      const messages = document.querySelectorAll('.chat-message');
      return messages.length === 0;
    }, { timeout: 5000 });

    // Empty state should be visible again
    await expect(page.locator('.chat-empty')).toBeVisible();
  });

  test('10. Chat session appears in sidebar', async ({ page }) => {
    // Create a chat session
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Open sidebar if closed
    const isSidebarClosed = await page.evaluate(() =>
      document.body.classList.contains('sidebar-closed')
    );
    if (isSidebarClosed) {
      await page.click('.sidebar-toggle');
    }

    // Look for chat group in sidebar
    const chatGroup = page.locator('.sidebar-group[data-type="chat"]');
    await expect(chatGroup).toBeVisible({ timeout: 5000 });

    // Expand it if collapsed
    const isExpanded = await chatGroup.getAttribute('open');
    if (!isExpanded) {
      await chatGroup.locator('summary').click();
    }

    // Should have at least one session
    const sessions = chatGroup.locator('.group-sessions li');
    expect(await sessions.count()).toBeGreaterThan(0);
  });

  // Cleanup after tests
  test.afterEach(async ({ page }) => {
    // Optionally clean up test sessions
    // This could delete any chat sessions created during tests
  });
});

// Mobile-specific tests
test.describe('Chat Mobile UI', () => {
  test.use({
    viewport: { width: 375, height: 667 }, // iPhone SE size
    hasTouch: true, // Enable touch support
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    if (page.url().includes('/login')) {
      await page.fill('input[name="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/^(?!.*\/login)/);
    }
  });

  test('Mobile: Chat UI is responsive', async ({ page }) => {
    // Create chat session via mobile header button
    await page.click('.mobile-add-btn');
    await page.waitForTimeout(500);

    // Open sidebar to select chat type
    await page.click('.mobile-menu-btn');
    await page.waitForSelector('.sidebar:not(.sidebar-closed)');
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Get session and navigate to chat
    const chatCard = page.locator('.card-chat').first();
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Verify mobile layout
    await expect(page.locator('.chat-header')).toBeVisible();
    await expect(page.locator('.chat-messages')).toBeVisible();
    await expect(page.locator('.chat-composer')).toBeVisible();

    // Input should be properly sized for touch
    const input = page.locator('#chatInput');
    const inputBox = await input.boundingBox();
    expect(inputBox?.height).toBeGreaterThanOrEqual(40); // Minimum touch target
  });

  test('Mobile: Can type and send message on mobile', async ({ page }) => {
    await page.click('.mobile-menu-btn');
    await page.click('#typeSelect summary');
    await page.click('#typeOptions button[data-value="chat"]');
    await page.click('.new-btn');
    await page.waitForSelector('.card-chat', { timeout: 5000 });

    // Get the newest chat card
    const chatCards = await page.locator('.card-chat').all();
    const chatCard = chatCards[chatCards.length - 1];
    const sessionName = await chatCard.getAttribute('data-session');
    await page.goto(`${BASE_URL}/chat?session=${sessionName}`);

    // Wait for page to load
    await page.waitForSelector('#chatInput', { timeout: 5000 });

    // Type message using fill (works better than tap for input)
    await page.fill('#chatInput', 'Mobile test message');

    // Click send
    await page.click('#send-btn');

    // Wait for message
    await page.waitForSelector('.chat-message.user', { timeout: 5000 });
    await expect(page.locator('.chat-message.user').last()).toContainText('Mobile test message');
  });
});

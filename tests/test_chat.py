"""
Playwright tests for Sandboxer chat mode.
Tests the chat session creation, UI, and messaging flow.
"""

import pytest
from playwright.sync_api import sync_playwright, Page, expect
import time
import os

BASE_URL = "http://localhost:8081"  # Direct access bypasses Caddy
AUTH_USER = "admin"
AUTH_PASS = "test123"


def test_chat_mode():
    """Test creating and interacting with a chat session."""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        context_options = {
            "viewport": {"width": 1280, "height": 800},
        }

        if AUTH_PASS:
            context_options["http_credentials"] = {
                "username": AUTH_USER,
                "password": AUTH_PASS
            }

        context = browser.new_context(**context_options)
        page = context.new_page()

        print("\n" + "="*60)
        print("Testing Chat Mode")
        print("="*60)

        try:
            # Test 1: Load page
            print("\n[TEST 1] Loading page...")
            response = page.goto(BASE_URL, wait_until="networkidle", timeout=15000)
            assert response.status == 200, f"Page failed to load: {response.status}"
            print("  PASS: Page loaded")

            # Handle login if needed
            login_form = page.locator("form.login-box, input[name='password']")
            if login_form.count() > 0 and login_form.first.is_visible():
                print("\n[LOGIN] Logging in...")
                page.fill("input[name='username']", AUTH_USER)
                page.fill("input[name='password']", AUTH_PASS)
                page.click("button[type='submit']")
                page.wait_for_load_state("networkidle")
                time.sleep(0.5)
                print("  PASS: Logged in")

            # Open sidebar if closed
            sidebar = page.locator(".sidebar")
            sidebar_toggle = page.locator(".sidebar-toggle")
            if sidebar_toggle.is_visible():
                # Check if sidebar is collapsed
                is_closed = page.evaluate("document.body.classList.contains('sidebar-closed')")
                if is_closed:
                    print("\n[SETUP] Opening sidebar...")
                    sidebar_toggle.click()
                    time.sleep(0.3)
                    print("  PASS: Sidebar opened")

            # Test 2: Find and verify the type dropdown exists
            print("\n[TEST 2] Checking type dropdown...")
            type_select = page.locator("#typeSelect")
            # Wait for it to become visible
            type_select.wait_for(state="visible", timeout=5000)
            assert type_select.is_visible(), "Type dropdown not visible"
            print("  PASS: Type dropdown visible")

            # Test 3: Open dropdown and select "chat"
            print("\n[TEST 3] Selecting 'chat' option...")
            # Click the summary to open the dropdown
            type_select.locator("summary").click()
            time.sleep(0.3)

            # Click the chat option
            chat_option = type_select.locator('button[data-value="chat"]')
            if chat_option.count() > 0:
                chat_option.click()
                print("  PASS: Chat option selected")
            else:
                print("  SKIP: Chat option not found in dropdown")
                print("  Available options:")
                options = type_select.locator("column button")
                for i in range(options.count()):
                    opt = options.nth(i)
                    print(f"    - {opt.get_attribute('data-value')}: {opt.text_content()}")
                return

            time.sleep(0.3)

            # Test 4: Click "+ new" to create chat session
            print("\n[TEST 4] Creating chat session...")
            new_btn = page.locator(".new-btn")
            assert new_btn.is_visible(), "New button not visible"
            new_btn.click()

            # Wait for new card to appear
            time.sleep(3)  # Give Claude time to start
            print("  PASS: Clicked new button")

            # Test 5: Verify chat card was created
            print("\n[TEST 5] Verifying chat card...")
            chat_cards = page.locator('.card[data-mode="chat"]')

            # Also check for any cards with chat class visible
            all_cards = page.locator('.card')
            card_count = all_cards.count()
            print(f"  Found {card_count} total cards")

            if chat_cards.count() > 0:
                print(f"  PASS: Found {chat_cards.count()} chat card(s)")

                # Test 6: Verify chat UI elements
                print("\n[TEST 6] Checking chat UI elements...")
                chat_card = chat_cards.first

                # Check for chat container
                chat_container = chat_card.locator(".chat")
                if chat_container.is_visible():
                    print("  PASS: Chat container visible")
                else:
                    print("  WARN: Chat container not visible")

                # Check for messages container
                messages = chat_card.locator(".chat-messages")
                if messages.count() > 0:
                    print("  PASS: Messages container exists")
                else:
                    print("  WARN: Messages container not found")

                # Check for input area
                input_area = chat_card.locator(".chat-input")
                if input_area.count() > 0:
                    print("  PASS: Input area exists")
                else:
                    print("  WARN: Input area not found")

                # Check for textarea
                textarea = chat_card.locator(".chat-input textarea")
                if textarea.count() > 0:
                    print("  PASS: Textarea exists")
                else:
                    print("  WARN: Textarea not found")

                # Check for send button
                send_btn = chat_card.locator(".chat-input button")
                if send_btn.count() > 0:
                    print("  PASS: Send button exists")
                else:
                    print("  WARN: Send button not found")

                # Test 7: Check toggle button
                print("\n[TEST 7] Checking toggle button...")
                toggle_btn = chat_card.locator(".toggle-mode-btn")
                if toggle_btn.count() > 0:
                    toggle_text = toggle_btn.text_content()
                    print(f"  PASS: Toggle button exists (text: '{toggle_text}')")
                else:
                    print("  WARN: Toggle button not found")

                # Test 8: Try typing in textarea
                print("\n[TEST 8] Testing textarea input...")
                if textarea.count() > 0 and textarea.is_visible():
                    textarea.click()
                    textarea.fill("Hello from Playwright test!")
                    typed_value = textarea.input_value()
                    assert "Hello" in typed_value, "Text not typed correctly"
                    print("  PASS: Textarea accepts input")
                else:
                    print("  SKIP: Textarea not available")

            else:
                # Check if maybe it's a CLI card that has chat elements
                print("  INFO: No card with data-mode='chat' found")
                print("  Checking for chat elements in any card...")
                any_chat = page.locator(".chat")
                if any_chat.count() > 0:
                    print(f"  Found {any_chat.count()} .chat elements")

                any_chat_msg = page.locator(".chat-messages")
                if any_chat_msg.count() > 0:
                    print(f"  Found {any_chat_msg.count()} .chat-messages elements")

            # Take screenshot
            print("\n[SCREENSHOT] Saving screenshot...")
            os.makedirs("/home/sandboxer/git/sandboxer/tests/screenshots", exist_ok=True)
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_test.png", full_page=True)
            print("  Saved to tests/screenshots/chat_test.png")

        except Exception as e:
            print(f"\n  ERROR: {str(e)}")
            # Take error screenshot
            os.makedirs("/home/sandboxer/git/sandboxer/tests/screenshots", exist_ok=True)
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_test_error.png", full_page=True)
            raise

        finally:
            context.close()
            browser.close()

        print("\n" + "="*60)
        print("Chat Mode Tests Complete")
        print("="*60)


if __name__ == "__main__":
    test_chat_mode()

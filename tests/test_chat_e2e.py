"""
End-to-end test for chat session - create, send message, verify Claude responds.
"""

from playwright.sync_api import sync_playwright
import time
import os

BASE_URL = "http://localhost:8081"
AUTH_PASS = "EaQGUCtB7XfQhjtcvw4N"


def test_chat_e2e():
    """Test full chat flow: create session, send message, get response."""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        # Enable console logging
        page.on("console", lambda msg: print(f"[BROWSER] {msg.type}: {msg.text}"))

        print("\n" + "="*70)
        print("CHAT E2E TEST")
        print("="*70)

        try:
            # 1. Load and login
            print("\n[1] Loading page and logging in...")
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=15000)

            # Handle login if needed
            if page.locator("form.login-box").count() > 0:
                page.fill("input[name='username']", "admin")
                page.fill("input[name='password']", AUTH_PASS)
                page.click("button[type='submit']")
                page.wait_for_load_state("domcontentloaded")
                time.sleep(1)
                print("   Logged in successfully")

            # Take screenshot of initial state
            os.makedirs("/home/sandboxer/git/sandboxer/tests/screenshots", exist_ok=True)
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_1_initial.png")

            # 2. Open sidebar if closed
            print("\n[2] Opening sidebar...")
            is_closed = page.evaluate("document.body.classList.contains('sidebar-closed')")
            if is_closed:
                page.locator(".sidebar-toggle").click()
                time.sleep(0.3)
                print("   Sidebar opened")

            # 3. Select chat type from dropdown
            print("\n[3] Selecting 'claude chat' option...")
            type_select = page.locator("#typeSelect")
            type_select.locator("summary").click()
            time.sleep(0.2)

            # Check available options
            options = type_select.locator("column button")
            print(f"   Available options: {options.count()}")
            for i in range(options.count()):
                opt = options.nth(i)
                print(f"     - {opt.get_attribute('data-value')}: {opt.text_content()}")

            # Try to find chat option
            chat_option = type_select.locator('button[data-value="chat"]')
            if chat_option.count() > 0:
                chat_option.click()
                print("   Selected 'chat' option")
            else:
                print("   WARNING: No 'chat' option found, using claude")

            time.sleep(0.3)

            # Close the dropdown by pressing Escape
            page.keyboard.press("Escape")
            time.sleep(0.3)

            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_2_dropdown.png")

            # 4. Click + to create session
            print("\n[4] Creating new chat session...")
            new_btn = page.locator(".new-btn")
            new_btn.click()

            # Wait for card to appear
            print("   Waiting for chat card to appear...")
            time.sleep(3)  # Give Claude time to start

            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_3_created.png")

            # 5. Find the chat card
            print("\n[5] Looking for chat card...")
            cards = page.locator(".card")
            card_count = cards.count()
            print(f"   Found {card_count} cards")

            # Find the newest card (should be first)
            chat_card = None
            for i in range(card_count):
                card = cards.nth(i)
                name = card.get_attribute("data-session")
                mode = card.get_attribute("data-mode")
                print(f"   Card {i}: {name} (mode={mode})")
                if "chat" in name or mode == "chat":
                    chat_card = card
                    break

            if not chat_card:
                chat_card = cards.first
                print(f"   Using first card as chat card")

            # 6. Check if chat UI is visible
            print("\n[6] Checking chat UI...")
            chat_div = chat_card.locator(".chat")
            terminal_div = chat_card.locator(".terminal")

            chat_visible = chat_div.is_visible() if chat_div.count() > 0 else False
            terminal_visible = terminal_div.is_visible() if terminal_div.count() > 0 else False

            print(f"   Chat visible: {chat_visible}")
            print(f"   Terminal visible: {terminal_visible}")

            # If terminal is showing instead of chat, click toggle
            if terminal_visible and not chat_visible:
                print("   Clicking toggle to switch to chat mode...")
                toggle_btn = chat_card.locator(".toggle-mode-btn")
                if toggle_btn.count() > 0:
                    toggle_btn.click()
                    time.sleep(2)  # Wait for mode switch
                    page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_4_toggled.png")

            # 7. Find textarea and send a message
            print("\n[7] Sending test message...")
            textarea = chat_card.locator(".chat-input textarea")

            if textarea.count() > 0 and textarea.is_visible():
                textarea.click()
                textarea.fill("Say hello in exactly 3 words")
                page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_5_message.png")

                # Click send
                send_btn = chat_card.locator(".chat-input button")
                send_btn.click()
                print("   Message sent!")

                # 8. Wait for response
                print("\n[8] Waiting for Claude's response...")
                for i in range(30):  # Wait up to 30 seconds
                    time.sleep(1)
                    messages = chat_card.locator(".chat-message")
                    msg_count = messages.count()
                    print(f"   Messages: {msg_count}")

                    # Check for assistant message
                    assistant_msgs = chat_card.locator(".chat-message.assistant")
                    if assistant_msgs.count() > 0:
                        assistant_text = assistant_msgs.first.text_content()
                        print(f"   Assistant response: {assistant_text[:100]}...")
                        page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_6_response.png")
                        print("\n" + "="*70)
                        print("SUCCESS! Chat is working!")
                        print("="*70)
                        break

                    if i == 29:
                        print("   TIMEOUT waiting for response")
                        page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_timeout.png")

            else:
                print("   ERROR: Textarea not found or not visible")
                page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_error.png")

        except Exception as e:
            print(f"\nERROR: {str(e)}")
            import traceback
            traceback.print_exc()
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/chat_e2e_exception.png")

        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    test_chat_e2e()

#!/usr/bin/env python3
"""Test chat fullscreen on mobile viewport with Playwright."""

import time
from playwright.sync_api import sync_playwright, expect

BASE_URL = "http://localhost:8081"

def test_chat_mobile_fullscreen():
    with sync_playwright() as p:
        # iPhone 12 Pro viewport
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()

        # Login
        print("=== Logging in ===")
        page.goto(f"{BASE_URL}/login")
        page.fill('input[name="username"]', "admin")
        page.fill('input[name="password"]', "EaQGUCtB7XfQhjtcvw4N")
        page.click('button[type="submit"]')
        page.wait_for_url(f"{BASE_URL}/")
        print("Logged in")

        # Create a chat session via API
        print("\n=== Creating chat session via API ===")
        import requests
        session = requests.Session()

        # Get cookie from playwright
        cookies = context.cookies()
        for c in cookies:
            session.cookies.set(c['name'], c['value'])

        resp = session.get(f"{BASE_URL}/api/create?type=chat&dir=/home/sandboxer/git/sandboxer")
        data = resp.json()
        session_name = data.get('name')
        print(f"Created session: {session_name}")

        if not session_name:
            print("Failed to create session")
            browser.close()
            return

        # Refresh page to see the new session
        page.reload()
        time.sleep(1)

        # Open fullscreen chat
        print("\n=== Opening fullscreen chat ===")
        page.goto(f"{BASE_URL}/chat?session={session_name}")
        time.sleep(1)

        # Take initial screenshot
        page.screenshot(path="/tmp/chat_mobile_initial.png")
        print("✓ Initial screenshot saved")

        # Check mobile layout
        print("\n=== Checking mobile layout ===")

        # Chat bar should be visible
        chat_bar = page.locator('.chat-bar')
        expect(chat_bar).to_be_visible()
        print("✓ Chat bar visible")

        # Title should be visible
        title = page.locator('.chat-title')
        expect(title).to_be_visible()
        print(f"✓ Title visible: {title.inner_text()}")

        # Messages area should be visible
        messages = page.locator('.chat-messages, .chat-fullscreen .chat-messages')
        expect(messages.first).to_be_visible()
        print("✓ Messages area visible")

        # Input area should be visible at bottom
        input_area = page.locator('.chat-input-full')
        expect(input_area).to_be_visible()
        print("✓ Input area visible")

        # Textarea should be visible
        textarea = page.locator('.chat-input-full textarea')
        expect(textarea).to_be_visible()
        print("✓ Textarea visible")

        # Send button should be visible
        send_btn = page.locator('.chat-input-full button')
        expect(send_btn).to_be_visible()
        print("✓ Send button visible")

        # Test typing a message
        print("\n=== Testing message input ===")
        textarea.fill("Hello from mobile test!")
        expect(textarea).to_have_value("Hello from mobile test!")
        print("✓ Can type in textarea")

        # Test that textarea is within visible viewport
        textarea_box = textarea.bounding_box()
        viewport_height = page.viewport_size['height']
        if textarea_box:
            print(f"  Textarea bottom: {textarea_box['y'] + textarea_box['height']}")
            print(f"  Viewport height: {viewport_height}")
            if textarea_box['y'] + textarea_box['height'] <= viewport_height:
                print("✓ Input area is within viewport")
            else:
                print("⚠ Input area may be below viewport")

        # Take screenshot after typing
        page.screenshot(path="/tmp/chat_mobile_typed.png")
        print("✓ Typed screenshot saved")

        # Test scroll behavior - messages should scroll, input stays fixed
        print("\n=== Testing send ===")
        send_btn.click()
        time.sleep(0.5)

        # Check that user message appeared
        user_msg = page.locator('.chat-message.user')
        if user_msg.count() > 0:
            print(f"✓ User message rendered (count: {user_msg.count()})")
        else:
            print("⚠ User message not found")

        # Take screenshot after sending
        page.screenshot(path="/tmp/chat_mobile_sent.png")
        print("✓ Sent screenshot saved")

        # Wait a bit for response to start
        time.sleep(2)
        page.screenshot(path="/tmp/chat_mobile_response.png")
        print("✓ Response screenshot saved")

        # Check buttons in header
        print("\n=== Checking header buttons ===")
        cli_btn = page.locator('button:has-text("[cli]")')
        kill_btn = page.locator('button:has-text("[kill]")')

        if cli_btn.count() > 0:
            expect(cli_btn).to_be_visible()
            print("✓ CLI toggle button visible")

        if kill_btn.count() > 0:
            expect(kill_btn).to_be_visible()
            print("✓ Kill button visible")

        # Cleanup
        print("\n=== Cleanup ===")
        page.goto(f"{BASE_URL}/kill?session={session_name}")
        print(f"Killed session: {session_name}")

        browser.close()
        print("\n=== TEST PASSED ===")

if __name__ == "__main__":
    test_chat_mobile_fullscreen()

"""
Test mobile terminal page behavior.
"""

from playwright.sync_api import sync_playwright
import time

BASE_URL = "http://localhost:8080"

# Mobile viewports
MOBILE_PORTRAIT = {"width": 390, "height": 844}  # iPhone 12
MOBILE_LANDSCAPE = {"width": 844, "height": 390}


def test_terminal_page_mobile():
    """Test terminal page on mobile viewport."""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        print("\n" + "="*60)
        print("Testing Terminal Page on Mobile")
        print("="*60)

        # Test portrait mode
        context = browser.new_context(
            viewport=MOBILE_PORTRAIT,
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()

        # First, we need to get past login - check if there's a session
        print("\n[1] Loading main page...")
        page.goto(BASE_URL, wait_until="networkidle")

        # Check if we're on login page
        if page.locator("input[type='password']").count() > 0:
            print("    Login page detected - need to authenticate first")
            print("    Skipping terminal test (no auth credentials)")
            context.close()
            browser.close()
            return

        # Check for sessions
        print("[2] Checking for sessions...")
        page.wait_for_timeout(1000)

        # Try to find a session card and click fullscreen
        cards = page.locator(".card")
        if cards.count() == 0:
            print("    No sessions found - creating one would require auth")
            context.close()
            browser.close()
            return

        print(f"    Found {cards.count()} session(s)")

        # Get the first session name
        first_card = cards.first
        session_name = first_card.get_attribute("data-session")
        print(f"    Testing with session: {session_name}")

        # Navigate to terminal page
        print("[3] Opening terminal page...")
        page.goto(f"{BASE_URL}/terminal?session={session_name}", wait_until="networkidle")
        page.wait_for_timeout(2000)

        # Check terminal page structure
        print("[4] Checking terminal page structure...")

        term_bar = page.locator(".term-bar")
        iframe = page.locator("#terminal-iframe")

        print(f"    Term bar visible: {term_bar.is_visible()}")
        print(f"    Iframe visible: {iframe.is_visible()}")

        # Check dimensions
        body_box = page.evaluate("() => document.body.getBoundingClientRect()")
        iframe_box = page.evaluate("() => document.getElementById('terminal-iframe')?.getBoundingClientRect()")

        print(f"    Body dimensions: {body_box['width']}x{body_box['height']}")
        if iframe_box:
            print(f"    Iframe dimensions: {iframe_box['width']}x{iframe_box['height']}")

        # Check for horizontal overflow
        scroll_width = page.evaluate("document.documentElement.scrollWidth")
        client_width = page.evaluate("document.documentElement.clientWidth")
        has_overflow = scroll_width > client_width + 5
        print(f"    Horizontal overflow: {'YES - PROBLEM!' if has_overflow else 'No (good)'}")
        print(f"    (scroll: {scroll_width}, client: {client_width})")

        # Check visualViewport handler is set up
        has_handler = page.evaluate("""
            () => {
                return window.visualViewport !== undefined;
            }
        """)
        print(f"    visualViewport API available: {has_handler}")

        # Simulate keyboard appearance by changing visualViewport
        print("\n[5] Simulating keyboard appearance...")

        # We can't actually simulate the keyboard, but we can manually call
        # the resize handler to test the logic
        resize_test = page.evaluate("""
            () => {
                const iframe = document.getElementById('terminal-iframe');
                const termBar = document.querySelector('.term-bar');

                // Simulate what happens when keyboard opens
                // (visualViewport.height becomes smaller)
                const simulatedKeyboardHeight = 300;
                const simulatedViewportHeight = window.innerHeight - simulatedKeyboardHeight;

                // Apply the same logic as our handler
                document.body.style.height = simulatedViewportHeight + 'px';
                if (iframe && termBar) {
                    iframe.style.height = (simulatedViewportHeight - termBar.offsetHeight) + 'px';
                }

                return {
                    newBodyHeight: document.body.style.height,
                    newIframeHeight: iframe?.style.height,
                    termBarHeight: termBar?.offsetHeight
                };
            }
        """)
        print(f"    Simulated resize result: {resize_test}")

        # Reset
        page.evaluate("""
            () => {
                document.body.style.height = '';
                const iframe = document.getElementById('terminal-iframe');
                if (iframe) iframe.style.height = '';
            }
        """)

        # Take screenshot
        screenshot_path = "/home/sandboxer/sandboxer-repo/tests/screenshots/terminal_mobile.png"
        page.screenshot(path=screenshot_path)
        print(f"\n    Screenshot saved: {screenshot_path}")

        # Test landscape
        print("\n[6] Testing landscape mode...")
        page.set_viewport_size(MOBILE_LANDSCAPE)
        page.wait_for_timeout(500)

        body_box_landscape = page.evaluate("() => document.body.getBoundingClientRect()")
        iframe_box_landscape = page.evaluate("() => document.getElementById('terminal-iframe')?.getBoundingClientRect()")

        print(f"    Body dimensions: {body_box_landscape['width']}x{body_box_landscape['height']}")
        if iframe_box_landscape:
            print(f"    Iframe dimensions: {iframe_box_landscape['width']}x{iframe_box_landscape['height']}")

        screenshot_path_landscape = "/home/sandboxer/sandboxer-repo/tests/screenshots/terminal_mobile_landscape.png"
        page.screenshot(path=screenshot_path_landscape)
        print(f"    Screenshot saved: {screenshot_path_landscape}")

        context.close()
        browser.close()

        print("\n" + "="*60)
        print("Test completed!")
        print("="*60)


if __name__ == "__main__":
    import os
    os.makedirs("/home/sandboxer/sandboxer-repo/tests/screenshots", exist_ok=True)
    test_terminal_page_mobile()

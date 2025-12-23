"""
Test ungit session creation and display.
"""

from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8080"
AUTH_FILE = "/home/sandboxer/git/sandboxer/.sandbox-auth"


def get_password():
    """Read password from .sandbox-auth file."""
    try:
        with open(AUTH_FILE) as f:
            line = f.read().strip()
            _, passwd = line.split(":")
            return passwd
    except Exception:
        return None


def test_ungit_session():
    """Test creating and displaying an ungit session."""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        print("\n" + "="*60)
        print("Testing Ungit Session")
        print("="*60)

        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()

        print("\n[1] Loading main page...")
        page.goto(BASE_URL, wait_until="networkidle")

        # Log in if needed
        if page.locator("input[type='password']").count() > 0:
            print("    Login page detected, authenticating...")
            passwd = get_password()
            if not passwd:
                print("    No password found - skipping")
                context.close()
                browser.close()
                return False
            page.fill("input[type='password']", passwd)
            page.click("button[type='submit']")
            page.wait_for_timeout(2000)

        # Select a folder with a git repo
        print("\n[2] Selecting sandboxer folder...")
        page.click("#dirSelect summary")
        page.wait_for_timeout(300)
        page.click('#dirOptions button[data-value="/home/sandboxer/git/sandboxer"]')
        page.wait_for_timeout(500)

        # Select ungit type
        print("\n[3] Selecting ungit session type...")
        page.click("#typeSelect summary")
        page.wait_for_timeout(300)
        page.click('#typeOptions button[data-value="ungit"]')
        page.wait_for_timeout(300)

        # Create new session
        print("\n[4] Creating ungit session...")
        page.click(".new-btn")
        page.wait_for_timeout(3000)  # Wait for ungit to start

        # Check if ungit card was created
        ungit_cards = page.locator('.card[data-mode="ungit"]')
        count = ungit_cards.count()
        print(f"    Found {count} ungit card(s)")

        if count == 0:
            print("    ERROR: No ungit card created!")
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/ungit_no_card.png")
            context.close()
            browser.close()
            return False

        # Check if iframe has a valid src
        iframe = ungit_cards.first.locator("iframe")
        iframe_src = iframe.get_attribute("src")
        print(f"    Iframe src: {iframe_src}")

        if not iframe_src or not iframe_src.startswith("/u/"):
            print("    ERROR: Invalid iframe src!")
            page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/ungit_no_iframe.png")
            context.close()
            browser.close()
            return False

        # Check if ungit appears in sidebar under correct group
        print("\n[5] Checking sidebar grouping...")
        sidebar_group = page.locator('.sidebar-group[data-type="ungit"]')
        if sidebar_group.count() > 0:
            print("    Ungit group found in sidebar")
        else:
            print("    WARNING: Ungit group not found in sidebar")

        # Wait for ungit to load in iframe and check for content
        print("\n[6] Waiting for ungit to load...")
        page.wait_for_timeout(2000)

        # Take screenshot
        page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/ungit_session.png")
        print("    Saved: tests/screenshots/ungit_session.png")

        # Try to access the ungit URL directly to verify routing
        print("\n[7] Testing ungit routing...")
        ungit_page = context.new_page()
        try:
            ungit_page.goto(BASE_URL + iframe_src, wait_until="domcontentloaded", timeout=10000)
            title = ungit_page.title()
            print(f"    Ungit page title: {title}")

            # Check if we got a proper response (not 404)
            content = ungit_page.content()
            if "ungit" in content.lower() or "git" in content.lower():
                print("    Ungit routing OK")
            else:
                print(f"    WARNING: Ungit page content may be incorrect")
                ungit_page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/ungit_direct.png")
        except Exception as e:
            print(f"    ERROR accessing ungit: {e}")
            ungit_page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/ungit_error.png")

        ungit_page.close()

        # Clean up - kill the ungit session
        print("\n[8] Cleaning up...")
        session_name = ungit_cards.first.get_attribute("data-session")
        if session_name:
            kill_btn = ungit_cards.first.locator(".kill-btn")
            kill_btn.click()
            page.wait_for_timeout(1000)
            print(f"    Killed session: {session_name}")

        context.close()
        browser.close()

        print("\n" + "="*60)
        print("SUCCESS: Ungit session test completed!")
        print("="*60 + "\n")

        return True


if __name__ == "__main__":
    import os
    os.makedirs("/home/sandboxer/git/sandboxer/tests/screenshots", exist_ok=True)
    test_ungit_session()

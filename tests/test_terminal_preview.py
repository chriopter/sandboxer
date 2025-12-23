"""
Test terminal preview fills its container completely.
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


def test_terminal_preview_fills_container():
    """Test that terminal preview iframe fills its container without gaps."""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        print("\n" + "="*60)
        print("Testing Terminal Preview Fill")
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
                return
            page.fill("input[type='password']", passwd)
            page.click("button[type='submit']")
            page.wait_for_timeout(2000)  # Wait for redirect

        # Clear any saved zoom preference to test default
        page.evaluate("localStorage.removeItem('sandboxer_zoom')")
        page.reload()
        page.wait_for_timeout(2000)

        # Manually trigger scale update after clearing localStorage
        page.evaluate("if (typeof updateTerminalScales === 'function') updateTerminalScales()")
        page.wait_for_timeout(500)

        # Debug: check localStorage
        zoom_val = page.evaluate("localStorage.getItem('sandboxer_zoom')")
        print(f"    Zoom in localStorage: {zoom_val} (null = using default)")

        # Find terminal cards (not chat mode)
        cards = page.locator(".card:not([data-mode='chat'])")
        if cards.count() == 0:
            print("    No terminal sessions found")
            context.close()
            browser.close()
            return

        print(f"    Found {cards.count()} terminal session(s)")

        # Check each terminal preview
        print("\n[2] Checking terminal preview dimensions...")

        results = page.evaluate("""
            () => {
                const results = [];
                document.querySelectorAll('.card:not([data-mode="chat"]) .terminal').forEach((terminal, i) => {
                    const iframe = terminal.querySelector('iframe');
                    if (!iframe) return;

                    const terminalRect = terminal.getBoundingClientRect();
                    const iframeRect = iframe.getBoundingClientRect();
                    const scale = parseFloat(getComputedStyle(iframe).getPropertyValue('--terminal-scale') ||
                                  terminal.style.getPropertyValue('--terminal-scale') || '0.5');

                    // Get computed transform
                    const transform = getComputedStyle(iframe).transform;

                    // The visible iframe dimensions after scaling
                    const scaledWidth = 800 * scale;  // Visible width (not the extra for scrollbar)
                    const scaledHeight = 450 * scale;

                    results.push({
                        index: i,
                        container: {
                            width: terminalRect.width,
                            height: terminalRect.height
                        },
                        scaled: {
                            width: scaledWidth,
                            height: scaledHeight
                        },
                        scale: scale,
                        widthMatch: Math.abs(scaledWidth - terminalRect.width) < 2,
                        heightMatch: Math.abs(scaledHeight - terminalRect.height) < 2
                    });
                });
                return results;
            }
        """)

        all_good = True
        for r in results:
            width_ok = "OK" if r['widthMatch'] else "MISMATCH"
            height_ok = "OK" if r['heightMatch'] else "MISMATCH"

            print(f"\n    Terminal #{r['index']}:")
            print(f"      Container: {r['container']['width']:.1f}x{r['container']['height']:.1f}")
            print(f"      Scaled:    {r['scaled']['width']:.1f}x{r['scaled']['height']:.1f}")
            print(f"      Scale:     {r['scale']:.4f}")
            print(f"      Width:     {width_ok}")
            print(f"      Height:    {height_ok}")

            if not r['widthMatch'] or not r['heightMatch']:
                all_good = False

        # Take screenshot
        print("\n[3] Taking screenshot...")
        page.screenshot(path="/home/sandboxer/git/sandboxer/tests/screenshots/terminal_preview.png")
        print("    Saved: tests/screenshots/terminal_preview.png")

        context.close()
        browser.close()

        print("\n" + "="*60)
        if all_good:
            print("SUCCESS: Terminal previews fill containers correctly!")
        else:
            print("ISSUE: Some terminals don't fill their containers")
        print("="*60 + "\n")

        return all_good


if __name__ == "__main__":
    import os
    os.makedirs("/home/sandboxer/git/sandboxer/tests/screenshots", exist_ok=True)
    test_terminal_preview_fills_container()

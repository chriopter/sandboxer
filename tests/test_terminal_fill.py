"""
Test terminal preview fills container and clips scrollbar properly.
Takes screenshots for visual verification.
"""

from playwright.sync_api import sync_playwright
import os

BASE_URL = "http://localhost:8080"
AUTH_FILE = "/home/sandboxer/git/sandboxer/.sandbox-auth"
SCREENSHOT_DIR = "/home/sandboxer/git/sandboxer/tests/screenshots"


def get_password():
    try:
        with open(AUTH_FILE) as f:
            return f.read().strip().split(":")[1]
    except:
        return None


def test_terminal_fill():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        print("\n" + "="*70)
        print("Terminal Preview Fill Test")
        print("="*70)

        # Login
        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        if page.locator("input[type='password']").count() > 0:
            passwd = get_password()
            if passwd:
                page.fill("input[type='password']", passwd)
                page.click("button[type='submit']")
                page.wait_for_timeout(2000)

        # Clear zoom preference and reload
        page.evaluate("localStorage.removeItem('sandboxer_zoom')")
        page.reload()
        page.wait_for_timeout(2000)
        page.evaluate("if (typeof updateTerminalScales === 'function') updateTerminalScales()")
        page.wait_for_timeout(500)

        # Find terminal cards
        cards = page.locator(".card:not([data-mode='chat'])")
        count = cards.count()
        print(f"\nFound {count} terminal session(s)")

        if count == 0:
            print("No terminals to test")
            context.close()
            browser.close()
            return

        # Take full page screenshot
        page.screenshot(path=f"{SCREENSHOT_DIR}/full_page.png")
        print(f"Saved: full_page.png")

        # Analyze each terminal
        for i in range(min(count, 3)):
            card = cards.nth(i)
            terminal = card.locator(".terminal")

            if terminal.count() == 0:
                continue

            # Get dimensions
            dims = page.evaluate("""
                (idx) => {
                    const cards = document.querySelectorAll('.card:not([data-mode="chat"])');
                    const card = cards[idx];
                    if (!card) return null;

                    const terminal = card.querySelector('.terminal');
                    const iframe = terminal?.querySelector('iframe');
                    if (!terminal || !iframe) return null;

                    const termRect = terminal.getBoundingClientRect();
                    const iframeRect = iframe.getBoundingClientRect();
                    const scale = parseFloat(terminal.style.getPropertyValue('--terminal-scale')) || 0.5;
                    const computedStyle = getComputedStyle(iframe);
                    const iframeWidth = parseFloat(computedStyle.width);
                    const iframeHeight = parseFloat(computedStyle.height);

                    return {
                        container: {
                            width: termRect.width,
                            height: termRect.height,
                            aspectRatio: termRect.width / termRect.height
                        },
                        iframe: {
                            cssWidth: iframeWidth,
                            cssHeight: iframeHeight,
                            scaledWidth: iframeWidth * scale,
                            scaledHeight: iframeHeight * scale,
                            aspectRatio: iframeWidth / iframeHeight
                        },
                        scale: scale,
                        // Check if iframe fills container
                        widthFill: (iframeWidth * scale) / termRect.width * 100,
                        heightFill: (iframeHeight * scale) / termRect.height * 100,
                        // Gap calculations
                        widthGap: termRect.width - (iframeWidth * scale),
                        heightGap: termRect.height - (iframeHeight * scale)
                    };
                }
            """, i)

            if dims:
                print(f"\n--- Terminal #{i} ---")
                print(f"Container:     {dims['container']['width']:.1f} x {dims['container']['height']:.1f}")
                print(f"               (aspect: {dims['container']['aspectRatio']:.3f}, target 16:9 = 1.778)")
                print(f"iframe CSS:    {dims['iframe']['cssWidth']:.0f} x {dims['iframe']['cssHeight']:.0f}")
                print(f"               (aspect: {dims['iframe']['aspectRatio']:.3f})")
                print(f"Scale:         {dims['scale']:.4f}")
                print(f"Scaled iframe: {dims['iframe']['scaledWidth']:.1f} x {dims['iframe']['scaledHeight']:.1f}")
                print(f"Fill %:        width={dims['widthFill']:.1f}%, height={dims['heightFill']:.1f}%")
                print(f"Gap (px):      width={dims['widthGap']:.1f}, height={dims['heightGap']:.1f}")

                # Assessment
                if abs(dims['widthGap']) < 5 and abs(dims['heightGap']) < 5:
                    print("Status:        GOOD - fills container")
                elif dims['widthGap'] > 5 or dims['heightGap'] > 5:
                    print("Status:        BAD - has empty space")
                else:
                    print("Status:        OK - slightly oversized (clips correctly)")

            # Screenshot individual terminal
            try:
                terminal.screenshot(path=f"{SCREENSHOT_DIR}/terminal_{i}.png")
                print(f"Screenshot:    terminal_{i}.png")
            except:
                print("Screenshot:    (failed)")

        # Summary
        print("\n" + "="*70)
        print("Check screenshots in tests/screenshots/")
        print("Look for:")
        print("  - Date '23-Dez-25' visible in bottom right")
        print("  - No scrollbar visible")
        print("  - No empty gaps in container")
        print("="*70 + "\n")

        context.close()
        browser.close()


if __name__ == "__main__":
    test_terminal_fill()

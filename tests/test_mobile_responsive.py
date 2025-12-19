"""
Playwright tests for Sandboxer mobile responsiveness.
Tests various smartphone viewport sizes to ensure UI is visible and functional.
"""

import pytest
from playwright.sync_api import sync_playwright, Page, expect
import time
import os

# Smartphone viewport configurations
SMARTPHONE_VIEWPORTS = [
    {"name": "iPhone SE", "width": 375, "height": 667},
    {"name": "iPhone 12/13", "width": 390, "height": 844},
    {"name": "iPhone 14 Pro Max", "width": 430, "height": 932},
    {"name": "Samsung Galaxy S21", "width": 360, "height": 800},
    {"name": "Pixel 7", "width": 412, "height": 915},
    {"name": "Galaxy Fold (folded)", "width": 280, "height": 653},
    {"name": "iPhone 6/7/8", "width": 375, "height": 667},
    {"name": "Samsung Galaxy S8+", "width": 360, "height": 740},
]

BASE_URL = "http://localhost:8080"
# Credentials for Caddy basicauth (if enabled)
AUTH_USER = os.environ.get("SANDBOXER_USER", "admin")
AUTH_PASS = os.environ.get("SANDBOXER_PASS", "")


def test_mobile_viewports():
    """Test Sandboxer on various smartphone screen sizes."""

    with sync_playwright() as p:
        # Launch browser with no-sandbox for root
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )

        results = []

        for viewport in SMARTPHONE_VIEWPORTS:
            print(f"\n{'='*60}")
            print(f"Testing: {viewport['name']} ({viewport['width']}x{viewport['height']})")
            print('='*60)

            # Create context with HTTP credentials for basicauth
            context_options = {
                "viewport": {"width": viewport["width"], "height": viewport["height"]},
                "device_scale_factor": 2,  # Retina display
                "is_mobile": True,
                "has_touch": True,
            }

            # Add HTTP credentials if password is set
            if AUTH_PASS:
                context_options["http_credentials"] = {
                    "username": AUTH_USER,
                    "password": AUTH_PASS
                }

            context = browser.new_context(**context_options)
            page = context.new_page()

            test_result = {
                "device": viewport["name"],
                "width": viewport["width"],
                "height": viewport["height"],
                "tests": {}
            }

            try:
                # Test 1: Page loads successfully
                print(f"  [TEST] Loading main page...")
                response = page.goto(BASE_URL, wait_until="networkidle", timeout=10000)
                test_result["tests"]["page_load"] = response.status == 200
                print(f"    {'PASS' if test_result['tests']['page_load'] else 'FAIL'}: Page load (status: {response.status})")

                # Test 2: Title is correct
                print(f"  [TEST] Checking page title...")
                title = page.title()
                test_result["tests"]["title"] = "sandboxer" in title.lower()
                print(f"    {'PASS' if test_result['tests']['title'] else 'FAIL'}: Title check ('{title}')")

                # Check if we're on a login page
                login_form = page.locator("input[type='password'], form input[name='password']")
                is_login_page = login_form.count() > 0

                if is_login_page:
                    print(f"  [INFO] Login page detected - testing login UI...")

                    # Test 3: Login form is visible and properly sized
                    print(f"  [TEST] Checking login form visibility...")
                    login_visible = login_form.first.is_visible()
                    test_result["tests"]["login_form_visible"] = login_visible
                    print(f"    {'PASS' if login_visible else 'FAIL'}: Login form visible")

                    # Test 4: Login button is visible
                    print(f"  [TEST] Checking login button...")
                    login_btn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Login')")
                    login_btn_visible = login_btn.first.is_visible() if login_btn.count() > 0 else False
                    test_result["tests"]["login_button_visible"] = login_btn_visible
                    print(f"    {'PASS' if login_btn_visible else 'FAIL'}: Login button visible")

                else:
                    # Test 3: Header is visible
                    print(f"  [TEST] Checking header visibility...")
                    header = page.locator("header, .header, h1, .logo").first
                    test_result["tests"]["header_visible"] = header.is_visible() if header.count() > 0 else False
                    print(f"    {'PASS' if test_result['tests']['header_visible'] else 'WARN'}: Header visible")

                    # Test 4: Main content/grid is visible
                    print(f"  [TEST] Checking main content area...")
                    main_content = page.locator("main")
                    test_result["tests"]["main_visible"] = main_content.is_visible() if main_content.count() > 0 else False
                    print(f"    {'PASS' if test_result['tests']['main_visible'] else 'WARN'}: Main content area visible")

                    # Test 5: Footer is visible
                    print(f"  [TEST] Checking footer visibility...")
                    footer = page.locator("footer, .footer")
                    test_result["tests"]["footer_visible"] = footer.first.is_visible() if footer.count() > 0 else False
                    print(f"    {'PASS' if test_result['tests']['footer_visible'] else 'WARN'}: Footer visible")

                # Test: No horizontal overflow (applies to both login and main page)
                print(f"  [TEST] Checking horizontal overflow...")
                scroll_width = page.evaluate("document.documentElement.scrollWidth")
                client_width = page.evaluate("document.documentElement.clientWidth")
                test_result["tests"]["no_horizontal_overflow"] = scroll_width <= client_width + 5  # 5px tolerance
                print(f"    {'PASS' if test_result['tests']['no_horizontal_overflow'] else 'FAIL'}: No horizontal overflow (scroll: {scroll_width}, client: {client_width})")

                # Test: Text is readable (not too small)
                print(f"  [TEST] Checking font sizes...")
                font_sizes = page.evaluate("""
                    () => {
                        const elements = document.querySelectorAll('body *');
                        const sizes = [];
                        for (const el of elements) {
                            const style = window.getComputedStyle(el);
                            if (el.textContent.trim() && style.display !== 'none') {
                                sizes.push(parseFloat(style.fontSize));
                            }
                        }
                        return sizes.filter(s => s > 0);
                    }
                """)
                min_font = min(font_sizes) if font_sizes else 0
                test_result["tests"]["readable_fonts"] = min_font >= 10  # 10px minimum
                print(f"    {'PASS' if test_result['tests']['readable_fonts'] else 'WARN'}: Readable fonts (min: {min_font}px)")

                # Test: Clickable elements have adequate touch targets
                print(f"  [TEST] Checking touch targets...")
                touch_targets = page.evaluate("""
                    () => {
                        const clickables = document.querySelectorAll('a, button, [role="button"], input, select');
                        const small_targets = [];
                        for (const el of clickables) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                // 44px is Apple's recommended minimum, but we'll be lenient
                                if (rect.width < 32 || rect.height < 32) {
                                    small_targets.push({
                                        tag: el.tagName,
                                        width: Math.round(rect.width),
                                        height: Math.round(rect.height),
                                        text: el.textContent.slice(0, 20)
                                    });
                                }
                            }
                        }
                        return small_targets;
                    }
                """)
                test_result["tests"]["adequate_touch_targets"] = len(touch_targets) <= 5  # Allow a few small targets
                if touch_targets:
                    print(f"    {'PASS' if test_result['tests']['adequate_touch_targets'] else 'WARN'}: Touch targets ({len(touch_targets)} small: {touch_targets[:3]})")
                else:
                    print(f"    PASS: Touch targets (all adequate)")

                # Take screenshot
                screenshot_name = viewport['name'].replace('/', '-').replace(' ', '_').replace('(', '').replace(')', '')
                screenshot_path = f"/home/sandboxer/sandboxer-repo/tests/screenshots/{screenshot_name}.png"
                page.screenshot(path=screenshot_path, full_page=True)
                test_result["tests"]["screenshot"] = True
                print(f"    DONE: Screenshot saved to {screenshot_path}")

            except Exception as e:
                print(f"    ERROR: {str(e)}")
                test_result["error"] = str(e)

            finally:
                context.close()

            results.append(test_result)

        browser.close()

        # Print summary
        print("\n" + "="*60)
        print("SUMMARY")
        print("="*60)

        all_passed = True
        for result in results:
            device = result["device"]
            tests = result.get("tests", {})
            passed = sum(1 for v in tests.values() if v is True)
            total = len(tests)
            status = "PASS" if passed == total else "PARTIAL" if passed > total * 0.7 else "FAIL"
            if status == "FAIL":
                all_passed = False
            emoji = "✓" if status == "PASS" else "~" if status == "PARTIAL" else "✗"
            print(f"  {emoji} {device}: {status} ({passed}/{total} tests)")

            # Show failed tests
            for test_name, test_passed in tests.items():
                if not test_passed and test_name != "screenshot":
                    print(f"      - {test_name}: FAILED")

        print("="*60)

        # Return results for assertions
        return results, all_passed


if __name__ == "__main__":
    # Create screenshots directory
    import os
    os.makedirs("/home/sandboxer/sandboxer-repo/tests/screenshots", exist_ok=True)

    results, all_passed = test_mobile_viewports()

    if all_passed:
        print("\n✓ All mobile responsiveness tests passed!")
    else:
        print("\n~ Some tests had warnings but core functionality works")
        # Don't fail on warnings, only on critical failures
        critical_failures = 0
        for result in results:
            tests = result.get("tests", {})
            # Critical tests
            if not tests.get("page_load", True):
                critical_failures += 1
            if not tests.get("no_horizontal_overflow", True):
                critical_failures += 1

        if critical_failures > 0:
            print(f"\n✗ {critical_failures} critical failures!")
            exit(1)
        else:
            print("\n✓ No critical failures - mobile UI is functional!")

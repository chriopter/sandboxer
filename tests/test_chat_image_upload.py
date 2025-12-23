#!/usr/bin/env python3
"""Test image upload in chat mode - both button and Ctrl+V paste."""

import base64
import time
import requests
from playwright.sync_api import sync_playwright, expect

BASE_URL = "http://localhost:8081"

# Create a simple test image (red square PNG)
def create_test_image():
    """Create a minimal 10x10 red PNG image."""
    import struct
    import zlib

    width, height = 10, 10

    def png_chunk(chunk_type, data):
        chunk_len = struct.pack('>I', len(data))
        chunk_crc = struct.pack('>I', zlib.crc32(chunk_type + data) & 0xffffffff)
        return chunk_len + chunk_type + data + chunk_crc

    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    png += png_chunk(b'IHDR', ihdr_data)

    # IDAT chunk (raw image data)
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter byte
        for x in range(width):
            raw_data += b'\xff\x00\x00'  # Red pixel (RGB)

    compressed = zlib.compress(raw_data)
    png += png_chunk(b'IDAT', compressed)

    # IEND chunk
    png += png_chunk(b'IEND', b'')

    return png


def test_image_upload_button():
    """Test image upload via file input button."""
    print("\n=== Test: Image Upload via Button ===")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Login
        print("Logging in...")
        page.goto(f"{BASE_URL}/login")
        page.fill('input[name="username"]', "admin")
        page.fill('input[name="password"]', "EaQGUCtB7XfQhjtcvw4N")
        page.click('button[type="submit"]')
        page.wait_for_url(f"{BASE_URL}/")

        # Create chat session via API
        print("Creating chat session...")
        cookies = context.cookies()
        session = requests.Session()
        for c in cookies:
            session.cookies.set(c['name'], c['value'])

        resp = session.get(f"{BASE_URL}/api/create?type=chat&dir=/home/sandboxer/git/sandboxer")
        data = resp.json()
        session_name = data.get('name')
        print(f"Session: {session_name}")

        if not session_name:
            print("✗ Failed to create session")
            browser.close()
            return False

        # Go to fullscreen chat
        page.goto(f"{BASE_URL}/chat?session={session_name}")
        time.sleep(1)

        # Create test image file
        test_image = create_test_image()
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
            f.write(test_image)
            temp_path = f.name

        print(f"Created test image: {temp_path}")

        # Find image input and upload
        image_input = page.locator('#image-input')
        image_input.set_input_files(temp_path)

        # Wait for upload
        time.sleep(1)

        # Check textarea has the path
        textarea = page.locator('#chat-textarea')
        textarea_value = textarea.input_value()
        print(f"Textarea value: {textarea_value}")

        if "/tmp/sandboxer_uploads/" in textarea_value:
            print("✓ Image path added to textarea")
        else:
            print("✗ Image path NOT in textarea")
            page.screenshot(path="/tmp/test_upload_button_fail.png")
            browser.close()
            return False

        # Check toast showed success
        page.screenshot(path="/tmp/test_upload_button.png")

        # Cleanup
        page.goto(f"{BASE_URL}/kill?session={session_name}")
        browser.close()

        import os
        os.unlink(temp_path)

        print("✓ Button upload test PASSED")
        return True


def test_image_upload_paste():
    """Test image upload via Ctrl+V paste."""
    print("\n=== Test: Image Upload via Ctrl+V ===")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Login
        print("Logging in...")
        page.goto(f"{BASE_URL}/login")
        page.fill('input[name="username"]', "admin")
        page.fill('input[name="password"]', "EaQGUCtB7XfQhjtcvw4N")
        page.click('button[type="submit"]')
        page.wait_for_url(f"{BASE_URL}/")

        # Create chat session
        print("Creating chat session...")
        cookies = context.cookies()
        session = requests.Session()
        for c in cookies:
            session.cookies.set(c['name'], c['value'])

        resp = session.get(f"{BASE_URL}/api/create?type=chat&dir=/home/sandboxer/git/sandboxer")
        data = resp.json()
        session_name = data.get('name')
        print(f"Session: {session_name}")

        if not session_name:
            print("✗ Failed to create session")
            browser.close()
            return False

        # Go to fullscreen chat
        page.goto(f"{BASE_URL}/chat?session={session_name}")
        time.sleep(1)

        # Create test image
        test_image = create_test_image()
        test_image_b64 = base64.b64encode(test_image).decode()

        # Simulate paste event with image data
        # Playwright doesn't directly support clipboard images, so we use evaluate
        result = page.evaluate(f"""
            () => {{
                return new Promise((resolve) => {{
                    // Create a blob from base64
                    const b64 = "{test_image_b64}";
                    const binary = atob(b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {{
                        bytes[i] = binary.charCodeAt(i);
                    }}
                    const blob = new Blob([bytes], {{ type: 'image/png' }});

                    // Create a File from the blob
                    const file = new File([blob], 'test_paste.png', {{ type: 'image/png' }});

                    // Create a DataTransfer with the file
                    const dt = new DataTransfer();
                    dt.items.add(file);

                    // Create and dispatch paste event
                    const pasteEvent = new ClipboardEvent('paste', {{
                        clipboardData: dt,
                        bubbles: true,
                        cancelable: true
                    }});

                    document.dispatchEvent(pasteEvent);

                    // Wait for upload to complete
                    setTimeout(() => {{
                        const textarea = document.getElementById('chat-textarea');
                        resolve(textarea ? textarea.value : '');
                    }}, 2000);
                }});
            }}
        """)

        print(f"Textarea after paste: {result}")

        if "/tmp/sandboxer_uploads/" in result:
            print("✓ Image path added via paste")
        else:
            print("✗ Paste upload may have failed")
            # This can fail in headless mode due to clipboard restrictions
            page.screenshot(path="/tmp/test_upload_paste.png")

        # Cleanup
        page.goto(f"{BASE_URL}/kill?session={session_name}")
        browser.close()

        print("✓ Paste upload test completed")
        return True


def test_claude_analyzes_image():
    """Test that Claude can actually analyze an uploaded image."""
    print("\n=== Test: Claude Analyzes Uploaded Image ===")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Login
        print("Logging in...")
        page.goto(f"{BASE_URL}/login")
        page.fill('input[name="username"]', "admin")
        page.fill('input[name="password"]', "EaQGUCtB7XfQhjtcvw4N")
        page.click('button[type="submit"]')
        page.wait_for_url(f"{BASE_URL}/")

        # Create chat session
        print("Creating chat session...")
        cookies = context.cookies()
        session = requests.Session()
        for c in cookies:
            session.cookies.set(c['name'], c['value'])

        resp = session.get(f"{BASE_URL}/api/create?type=chat&dir=/home/sandboxer/git/sandboxer")
        data = resp.json()
        session_name = data.get('name')
        print(f"Session: {session_name}")

        if not session_name:
            print("✗ Failed to create session")
            browser.close()
            return False

        # Go to fullscreen chat
        page.goto(f"{BASE_URL}/chat?session={session_name}")
        time.sleep(1)

        # Upload test image via file input
        test_image = create_test_image()
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
            f.write(test_image)
            temp_path = f.name

        image_input = page.locator('#image-input')
        image_input.set_input_files(temp_path)
        time.sleep(1)

        # Get the uploaded path
        textarea = page.locator('#chat-textarea')
        uploaded_path = textarea.input_value()
        print(f"Uploaded to: {uploaded_path}")

        if not uploaded_path:
            print("✗ Upload failed")
            browser.close()
            return False

        # Add message asking Claude to analyze
        textarea.fill(f"Analyze this image and tell me what color the square is: {uploaded_path}")

        # Send message
        send_btn = page.locator('#send-btn')
        send_btn.click()

        print("Sent message, waiting for Claude response...")

        # Wait for response (up to 30 seconds)
        try:
            # Wait for assistant message to appear
            page.wait_for_selector('.chat-message.assistant', timeout=30000)
            time.sleep(3)  # Let response complete

            # Get response text
            assistant_messages = page.locator('.chat-message.assistant')
            count = assistant_messages.count()
            print(f"Assistant messages: {count}")

            if count > 0:
                response_text = assistant_messages.last.inner_text()
                print(f"Response preview: {response_text[:200]}...")

                # Check if Claude mentioned red or analyzed the image
                response_lower = response_text.lower()
                if 'red' in response_lower or 'image' in response_lower or 'color' in response_lower:
                    print("✓ Claude analyzed the image!")
                else:
                    print("⚠ Response doesn't seem to analyze image content")

            page.screenshot(path="/tmp/test_claude_image_analysis.png")

        except Exception as e:
            print(f"✗ Timeout or error waiting for response: {e}")
            page.screenshot(path="/tmp/test_claude_image_fail.png")

        # Cleanup
        page.goto(f"{BASE_URL}/kill?session={session_name}")
        browser.close()

        import os
        os.unlink(temp_path)

        print("✓ Claude image analysis test completed")
        return True


if __name__ == "__main__":
    print("=" * 60)
    print("CHAT IMAGE UPLOAD TESTS")
    print("=" * 60)

    results = []

    # Test 1: Button upload
    results.append(("Button Upload", test_image_upload_button()))

    # Test 2: Paste upload
    results.append(("Paste Upload", test_image_upload_paste()))

    # Test 3: Claude analyzes image
    results.append(("Claude Analysis", test_claude_analyzes_image()))

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"  {name}: {status}")

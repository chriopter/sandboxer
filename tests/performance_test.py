#!/usr/bin/env python3
"""
Sandboxer Performance Tests using Playwright

Run with: python3 tests/performance_test.py
"""

import asyncio
import time
import statistics
from playwright.async_api import async_playwright
import aiohttp

BASE_URL = "http://localhost:8080"
AUTH = aiohttp.BasicAuth("admin", "admin")

# Results storage
results = {
    "dashboard_load": [],
    "api_sessions": [],
    "api_stats": [],
    "api_crons": [],
    "terminal_load": [],
    "concurrent_users": [],
}


async def measure_request(session, url, name):
    """Measure a single HTTP request."""
    start = time.perf_counter()
    try:
        async with session.get(url) as resp:
            await resp.text()
            elapsed = (time.perf_counter() - start) * 1000
            results[name].append(elapsed)
            return elapsed, resp.status
    except Exception as e:
        return None, str(e)


async def test_api_endpoints():
    """Test API endpoint response times."""
    print("\n=== API Endpoint Tests ===")

    async with aiohttp.ClientSession(auth=AUTH) as session:
        # Warm up
        await session.get(f"{BASE_URL}/api/sessions")

        # Test each endpoint multiple times
        endpoints = [
            ("/api/sessions", "api_sessions"),
            ("/api/stats", "api_stats"),
            ("/api/crons", "api_crons"),
        ]

        for endpoint, name in endpoints:
            print(f"\nTesting {endpoint}...")
            for i in range(20):
                elapsed, status = await measure_request(session, f"{BASE_URL}{endpoint}", name)
                if elapsed:
                    print(f"  Request {i+1}: {elapsed:.1f}ms (status: {status})")
                await asyncio.sleep(0.1)


async def test_concurrent_api_load():
    """Simulate multiple users hitting API simultaneously."""
    print("\n=== Concurrent API Load Test ===")

    async def user_session(user_id, num_requests):
        """Simulate a user making requests."""
        times = []
        async with aiohttp.ClientSession(auth=AUTH) as session:
            for i in range(num_requests):
                start = time.perf_counter()
                try:
                    # Simulate realistic user behavior
                    await session.get(f"{BASE_URL}/api/sessions")
                    await session.get(f"{BASE_URL}/api/stats")
                    elapsed = (time.perf_counter() - start) * 1000
                    times.append(elapsed)
                except Exception as e:
                    print(f"  User {user_id} error: {e}")
                await asyncio.sleep(0.5)  # User think time
        return times

    # Test with increasing concurrent users
    for num_users in [1, 5, 10, 20]:
        print(f"\nTesting with {num_users} concurrent users...")
        start = time.perf_counter()

        tasks = [user_session(i, 5) for i in range(num_users)]
        all_times = await asyncio.gather(*tasks)

        flat_times = [t for times in all_times for t in times]
        total_time = (time.perf_counter() - start) * 1000

        if flat_times:
            print(f"  Total requests: {len(flat_times)}")
            print(f"  Total time: {total_time:.0f}ms")
            print(f"  Avg response: {statistics.mean(flat_times):.1f}ms")
            print(f"  P95 response: {sorted(flat_times)[int(len(flat_times)*0.95)]:.1f}ms")
            print(f"  Max response: {max(flat_times):.1f}ms")
            results["concurrent_users"].append({
                "users": num_users,
                "avg_ms": statistics.mean(flat_times),
                "p95_ms": sorted(flat_times)[int(len(flat_times)*0.95)],
                "max_ms": max(flat_times),
            })


async def test_stats_polling_load():
    """Test /api/stats under heavy polling (simulates many browser tabs)."""
    print("\n=== Stats Polling Load Test ===")

    async def poll_stats(poll_id, duration_sec):
        """Poll stats endpoint for a duration."""
        times = []
        async with aiohttp.ClientSession(auth=AUTH) as session:
            end_time = time.perf_counter() + duration_sec
            while time.perf_counter() < end_time:
                start = time.perf_counter()
                try:
                    await session.get(f"{BASE_URL}/api/stats")
                    elapsed = (time.perf_counter() - start) * 1000
                    times.append(elapsed)
                except:
                    pass
                await asyncio.sleep(0.5)  # Simulate 500ms polling
        return times

    # Simulate 10 tabs polling for 5 seconds
    print("Simulating 10 browser tabs polling /api/stats for 5 seconds...")
    tasks = [poll_stats(i, 5) for i in range(10)]
    all_times = await asyncio.gather(*tasks)

    flat_times = [t for times in all_times for t in times]
    if flat_times:
        print(f"  Total polls: {len(flat_times)}")
        print(f"  Requests/sec: {len(flat_times)/5:.1f}")
        print(f"  Avg response: {statistics.mean(flat_times):.1f}ms")
        print(f"  P95 response: {sorted(flat_times)[int(len(flat_times)*0.95)]:.1f}ms")


async def test_dashboard_with_playwright():
    """Test dashboard load performance with real browser."""
    print("\n=== Dashboard Browser Tests ===")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            http_credentials={"username": "admin", "password": "admin"}
        )

        # Test dashboard load times
        print("\nMeasuring dashboard load times...")
        for i in range(5):
            page = await context.new_page()

            # Enable performance tracking
            await page.evaluate("() => window.performance.mark('start')")

            start = time.perf_counter()
            await page.goto(BASE_URL, wait_until="networkidle")
            load_time = (time.perf_counter() - start) * 1000

            # Get performance metrics
            metrics = await page.evaluate("""() => {
                const perf = window.performance;
                const timing = perf.timing || {};
                const entries = perf.getEntriesByType('resource');
                return {
                    domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
                    load: timing.loadEventEnd - timing.navigationStart,
                    resources: entries.length,
                    totalTransfer: entries.reduce((sum, e) => sum + (e.transferSize || 0), 0)
                };
            }""")

            results["dashboard_load"].append(load_time)
            print(f"  Load {i+1}: {load_time:.0f}ms (DOM: {metrics.get('domContentLoaded', 'N/A')}ms, "
                  f"Resources: {metrics.get('resources', 'N/A')}, "
                  f"Transfer: {metrics.get('totalTransfer', 0)/1024:.1f}KB)")

            await page.close()
            await asyncio.sleep(1)

        # Test terminal page load
        print("\nMeasuring terminal page load times...")

        # First get a session name
        page = await context.new_page()
        await page.goto(BASE_URL, wait_until="networkidle")

        # Find first session card
        card = await page.query_selector(".card[data-session]")
        if card:
            session_name = await card.get_attribute("data-session")
            await page.close()

            for i in range(3):
                page = await context.new_page()
                start = time.perf_counter()
                await page.goto(f"{BASE_URL}/terminal?session={session_name}", wait_until="networkidle")
                load_time = (time.perf_counter() - start) * 1000
                results["terminal_load"].append(load_time)
                print(f"  Terminal load {i+1}: {load_time:.0f}ms")
                await page.close()
                await asyncio.sleep(0.5)
        else:
            print("  No sessions found to test terminal load")

        await browser.close()


async def test_scroll_performance():
    """Test scrolling performance with many sessions."""
    print("\n=== Scroll Performance Test ===")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            http_credentials={"username": "admin", "password": "admin"}
        )
        page = await context.new_page()

        await page.goto(BASE_URL, wait_until="networkidle")

        # Measure frame rate during scroll
        fps_samples = await page.evaluate("""async () => {
            const samples = [];
            let lastTime = performance.now();
            let frameCount = 0;

            const measureFPS = () => {
                frameCount++;
                const now = performance.now();
                if (now - lastTime >= 1000) {
                    samples.push(frameCount);
                    frameCount = 0;
                    lastTime = now;
                }
            };

            // Scroll and measure for 3 seconds
            const scrollContainer = document.querySelector('main') || document.body;
            let scrollPos = 0;

            return new Promise(resolve => {
                const interval = setInterval(() => {
                    scrollPos += 100;
                    scrollContainer.scrollTop = scrollPos;
                    measureFPS();
                }, 16); // ~60fps target

                setTimeout(() => {
                    clearInterval(interval);
                    resolve(samples);
                }, 3000);
            });
        }""")

        if fps_samples:
            print(f"  FPS samples: {fps_samples}")
            print(f"  Avg FPS: {statistics.mean(fps_samples) if fps_samples else 'N/A'}")

        await browser.close()


async def test_memory_leak():
    """Test for memory leaks during extended use."""
    print("\n=== Memory Leak Test ===")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            http_credentials={"username": "admin", "password": "admin"}
        )
        page = await context.new_page()

        await page.goto(BASE_URL, wait_until="networkidle")

        # Get initial memory
        initial_memory = await page.evaluate("() => performance.memory?.usedJSHeapSize || 0")

        # Simulate user activity for 30 seconds
        print("  Simulating 30 seconds of user activity...")
        for i in range(30):
            # Trigger various actions
            await page.evaluate("() => { populateSidebar && populateSidebar(); }")
            await asyncio.sleep(1)

        # Get final memory
        final_memory = await page.evaluate("() => performance.memory?.usedJSHeapSize || 0")

        if initial_memory and final_memory:
            growth = (final_memory - initial_memory) / 1024 / 1024
            print(f"  Initial heap: {initial_memory/1024/1024:.1f}MB")
            print(f"  Final heap: {final_memory/1024/1024:.1f}MB")
            print(f"  Growth: {growth:.2f}MB")
        else:
            print("  Memory API not available in this browser context")

        await browser.close()


def print_summary():
    """Print test summary with statistics."""
    print("\n" + "="*60)
    print("PERFORMANCE TEST SUMMARY")
    print("="*60)

    for name, times in results.items():
        if not times:
            continue

        if isinstance(times[0], dict):
            # Concurrent users results
            print(f"\n{name}:")
            for entry in times:
                print(f"  {entry['users']} users: avg={entry['avg_ms']:.1f}ms, "
                      f"p95={entry['p95_ms']:.1f}ms, max={entry['max_ms']:.1f}ms")
        else:
            # Simple timing results
            print(f"\n{name}:")
            print(f"  Count: {len(times)}")
            print(f"  Min: {min(times):.1f}ms")
            print(f"  Max: {max(times):.1f}ms")
            print(f"  Avg: {statistics.mean(times):.1f}ms")
            if len(times) >= 2:
                print(f"  Std: {statistics.stdev(times):.1f}ms")
            if len(times) >= 20:
                sorted_times = sorted(times)
                print(f"  P50: {sorted_times[len(times)//2]:.1f}ms")
                print(f"  P95: {sorted_times[int(len(times)*0.95)]:.1f}ms")

    print("\n" + "="*60)
    print("BOTTLENECK ANALYSIS")
    print("="*60)

    issues = []

    if results["dashboard_load"]:
        avg = statistics.mean(results["dashboard_load"])
        if avg > 2000:
            issues.append(f"🔴 CRITICAL: Dashboard load avg {avg:.0f}ms (target: <2000ms)")
        elif avg > 1000:
            issues.append(f"🟡 WARNING: Dashboard load avg {avg:.0f}ms (target: <1000ms)")

    if results["api_stats"]:
        avg = statistics.mean(results["api_stats"])
        if avg > 100:
            issues.append(f"🔴 CRITICAL: /api/stats avg {avg:.0f}ms (target: <100ms)")
        elif avg > 50:
            issues.append(f"🟡 WARNING: /api/stats avg {avg:.0f}ms (target: <50ms)")

    if results["api_sessions"]:
        avg = statistics.mean(results["api_sessions"])
        if avg > 500:
            issues.append(f"🔴 CRITICAL: /api/sessions avg {avg:.0f}ms (target: <500ms)")
        elif avg > 200:
            issues.append(f"🟡 WARNING: /api/sessions avg {avg:.0f}ms (target: <200ms)")

    if results["concurrent_users"]:
        for entry in results["concurrent_users"]:
            if entry["users"] >= 10 and entry["p95_ms"] > 2000:
                issues.append(f"🔴 CRITICAL: {entry['users']} users P95 = {entry['p95_ms']:.0f}ms")

    if issues:
        for issue in issues:
            print(issue)
    else:
        print("✅ All metrics within acceptable ranges")


async def main():
    print("="*60)
    print("SANDBOXER PERFORMANCE TEST SUITE")
    print("="*60)
    print(f"Target: {BASE_URL}")

    try:
        # Quick connectivity check
        async with aiohttp.ClientSession(auth=AUTH) as session:
            async with session.get(f"{BASE_URL}/api/stats") as resp:
                if resp.status != 200:
                    print(f"Error: Server returned {resp.status}")
                    return
        print("✓ Server is reachable\n")

        # Run all tests
        await test_api_endpoints()
        await test_concurrent_api_load()
        await test_stats_polling_load()
        await test_dashboard_with_playwright()
        await test_scroll_performance()
        # await test_memory_leak()  # Takes 30s, uncomment for full test

        print_summary()

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())

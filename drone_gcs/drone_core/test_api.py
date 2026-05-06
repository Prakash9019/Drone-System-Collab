#!/usr/bin/env python3
"""Quick test to verify the backend can connect via the API."""

import asyncio
import aiohttp
import sys

API_URL = "http://localhost:8000"

async def test_connection(url: str, baud: int = 57600, label: str = ""):
    """Test a specific connection."""
    print(f"\n🔗 Testing {label}: {url}")
    
    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(
                f"{API_URL}/api/connect",
                json={"url": url, "baud": baud},
                timeout=aiohttp.ClientTimeout(total=20)
            ) as resp:
                data = await resp.json()
                if resp.status == 200:
                    print(f"✅ Connected successfully!")
                    print(f"   Vehicle: {data.get('sysid')}:{data.get('compid')}")
                    
                    # Try to get state
                    async with session.get(f"{API_URL}/api/state") as state_resp:
                        state_data = await state_resp.json()
                        vehicles = state_data.get('vehicles', {})
                        if vehicles:
                            print(f"✅ Telemetry available from {len(vehicles)} vehicle(s)")
                        
                    return True
                else:
                    print(f"❌ Connection failed ({resp.status}): {data}")
                    return False
        except asyncio.TimeoutError:
            print(f"⏱️  Connection timeout (20s)")
            return False
        except Exception as e:
            print(f"❌ Connection error: {type(e).__name__}: {e}")
            return False

async def main():
    """Test API and different connection modes."""
    print("=" * 60)
    print("Drone GCS Backend - Connection Test")
    print("=" * 60)
    
    print("\n📍 Testing API availability...")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{API_URL}/api/state") as resp:
                if resp.status == 200:
                    data = await resp.json()
                    print(f"✅ API is responding (status: {data['status']})")
                else:
                    print(f"❌ API error: {resp.status}")
                    return False
    except Exception as e:
        print(f"❌ Cannot reach API at {API_URL}")
        print(f"   Make sure backend is running: uvicorn app:app --reload --host 0.0.0.0 --port 8000")
        return False
    
    print("\n" + "=" * 60)
    print("Connection Mode Tests")
    print("=" * 60)
    
    results = []
    
    # Test 1: Direct serial connection (like MissionPlanner)
    results.append(await test_connection(
        "serial:/dev/tty.SIYI-6801129585",
        baud=115200,
        label="Direct Serial (MissionPlanner mode)"
    ))
    
    # Test 2: MAVProxy UDP forwarding
    results.append(await test_connection(
        "udp:127.0.0.1:14550",
        baud=57600,
        label="UDP (MAVProxy forwarding)"
    ))
    
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    
    if results[0]:
        print("✅ Direct serial connection works (MissionPlanner mode)")
    else:
        print("❌ Direct serial connection failed")
        print("   → Make sure the device is connected and path is correct")
    
    if results[1]:
        print("✅ UDP connection works (MAVProxy mode)")
    else:
        print("⚠️  UDP connection failed")
        print("   → Make sure MAVProxy is running with --out udp:127.0.0.1:14550")
    
    print("\n" + "=" * 60)
    return any(results)

if __name__ == "__main__":
    result = asyncio.run(main())
    sys.exit(0 if result else 1)

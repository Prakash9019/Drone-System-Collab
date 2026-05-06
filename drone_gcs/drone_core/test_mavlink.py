import asyncio
import logging
import sys
import os

# Add the drone_core directory to the path so we can import mavlink_link
sys.path.insert(0, os.path.dirname(__file__))

from mavlink_link import MAVLinkLink

# Configure logging to see the output
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

async def test_mavlink_connection():
    """Test the MAVLink connection with SITL or real drone."""

    # Create the MAVLink link instance
    link = MAVLinkLink()

    try:
        # For testing with ArduPilot SITL (recommended):
        # First, start SITL in another terminal:
        # sim_vehicle.py -v ArduCopter --out=udp:127.0.0.1:14550
        connection_string = "udp:127.0.0.1:14550"
        # For real drone via serial (uncomment and modify):
        # connection_string = "/dev/tty.SIYI-6801129585"  # Linux serial port
        # connection_string = "COM3"  # Windows serial port
        # baud = 57600  # Common baud rate for MAVLink

        print(f"Connecting to: {connection_string}")
        await link.connect(connection_string)

        print("Connected! Waiting for telemetry data...")
        print("You should see heartbeat messages and telemetry updates in the logs.")

        # Keep running for 30 seconds to receive data
        await asyncio.sleep(30)

    except KeyboardInterrupt:
        print("Interrupted by user")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await link.disconnect()
        print("Disconnected")

if __name__ == "__main__":
    asyncio.run(test_mavlink_connection())
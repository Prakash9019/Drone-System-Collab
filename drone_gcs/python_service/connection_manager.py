import serial.tools.list_ports
import logging
import asyncio
from pymavlink import mavutil
from typing import Optional, List

logger = logging.getLogger(__name__)

COMMON_BAUDRATES = [115200, 57600, 38400, 9600]

def get_available_serial_ports() -> List[str]:
    """Scan and return a list of available serial ports."""
    ports = serial.tools.list_ports.comports()
    # Filter out common non-device ports if necessary, but returning all is safer
    return [port.device for port in ports]

async def auto_detect_connection() -> Optional[str]:
    """
    Attempt to find a valid MAVLink connection by scanning serial ports
    and common baud rates. Returns the connection string if found.
    """
    logger.info("Starting auto-detection of MAVLink devices...")
    ports = get_available_serial_ports()
    
    if not ports:
        logger.warning("No serial ports found during auto-detection.")
        return None

    for port in ports:
        for baud in COMMON_BAUDRATES:
            logger.info(f"Testing {port} at {baud} baud...")
            try:
                # Open connection
                conn = mavutil.mavlink_connection(port, baud=baud, autoreconnect=False)
                
                # Wait briefly for a heartbeat
                msg = conn.recv_match(type='HEARTBEAT', blocking=True, timeout=1.5)
                conn.close()
                
                if msg:
                    logger.info(f"Success! Found MAVLink device on {port} at {baud} baud.")
                    return f"{port}:{baud}"
            except Exception as e:
                logger.debug(f"Failed to test {port} at {baud}: {e}")
                
    logger.info("Auto-detection failed to find any MAVLink devices.")
    return None

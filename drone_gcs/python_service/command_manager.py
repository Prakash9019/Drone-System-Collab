import asyncio
import time
import logging
from pymavlink import mavutil
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

def mav_result_text(result: int) -> str:
    names = {
        mavutil.mavlink.MAV_RESULT_ACCEPTED: "ACCEPTED",
        mavutil.mavlink.MAV_RESULT_TEMPORARILY_REJECTED: "TEMPORARILY_REJECTED",
        mavutil.mavlink.MAV_RESULT_DENIED: "DENIED",
        mavutil.mavlink.MAV_RESULT_UNSUPPORTED: "UNSUPPORTED",
        mavutil.mavlink.MAV_RESULT_FAILED: "FAILED",
        mavutil.mavlink.MAV_RESULT_IN_PROGRESS: "IN_PROGRESS",
        mavutil.mavlink.MAV_RESULT_COMMAND_LONG_ONLY: "COMMAND_LONG_ONLY",
        mavutil.mavlink.MAV_RESULT_COMMAND_INT_ONLY: "COMMAND_INT_ONLY",
    }
    r = int(result)
    return names.get(r, f"MAV_RESULT_{r}")

class CommandManager:
    """
    Manages the lifecycle of MAVLink commands sent to vehicles.
    Includes locking to prevent overlapping commands to the same vehicle,
    retry logic, and handling MAV_RESULT_IN_PROGRESS for long-running commands.
    """
    def __init__(self, link_manager):
        self.lm = link_manager
        self._locks: Dict[str, asyncio.Lock] = {}
        # Stores the current ACK result for a given command.
        # Key: f"{sysid}_{compid}_{command}"
        self._pending_acks: Dict[str, Optional[Dict[str, Any]]] = {}
        
        # State tracking for the frontend/event bus
        # Maps vehicle ID (sysid) to its active command state
        self._active_commands: Dict[int, Dict[str, Any]] = {}

    def _get_lock(self, sysid: int, compid: int) -> asyncio.Lock:
        key = f"{sysid}_{compid}"
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def on_command_ack(self, msg: Any):
        sysid = msg.get_srcSystem()
        compid = msg.get_srcComponent()
        command = msg.command
        result = msg.result
        
        # Extract progress from param2 if available and result is IN_PROGRESS
        progress = 0
        if result == mavutil.mavlink.MAV_RESULT_IN_PROGRESS:
            progress = getattr(msg, 'progress', getattr(msg, 'result_param2', 0))
            
        key = f"{sysid}_{compid}_{command}"
        
        # If there's an active command for this sysid, update its state
        if sysid in self._active_commands and self._active_commands[sysid]["command"] == command:
            self._active_commands[sysid]["result"] = result
            self._active_commands[sysid]["result_text"] = mav_result_text(result)
            if result == mavutil.mavlink.MAV_RESULT_IN_PROGRESS:
                self._active_commands[sysid]["progress"] = progress
            self._active_commands[sysid]["last_update"] = time.time()
            
        if key in self._pending_acks:
            # We record the ACK payload
            self._pending_acks[key] = {
                "result": result,
                "progress": progress,
                "msg": msg
            }

    async def execute_command(
        self, 
        sysid: int, 
        compid: int, 
        command: int, 
        p1=0, p2=0, p3=0, p4=0, p5=0, p6=0, p7=0, 
        is_int=False, 
        frame=0,
        retries=3
    ) -> Dict[str, Any]:
        """
        Executes a command sequentially for the given vehicle, waiting for an ACK.
        Handles IN_PROGRESS extensions and retries.
        """
        if not self.lm.conn:
            return {
                "accepted": False,
                "mav_result": -1,
                "mav_result_text": "NO_CONNECTION",
                "reason": "no_connection",
                "command": int(command),
            }

        lock = self._get_lock(sysid, compid)
        async with lock:
            ack_key = f"{sysid}_{compid}_{command}"
            
            # Setup active command tracking for frontend
            self._active_commands[sysid] = {
                "command": int(command),
                "is_executing": True,
                "progress": 0,
                "result": -1,
                "result_text": "WAITING",
                "started_at": time.time(),
                "last_update": time.time()
            }

            try:
                for attempt in range(retries):
                    self._pending_acks[ack_key] = None
                    
                    try:
                        if is_int:
                            self.lm.conn.mav.command_int_send(
                                sysid, compid,
                                frame,
                                command,
                                0, # current
                                0, # autocontinue
                                p1, p2, p3, p4,
                                int(p5), int(p6), float(p7)
                            )
                        else:
                            self.lm.conn.mav.command_long_send(
                                sysid, compid,
                                command,
                                0,  # confirmation
                                p1, p2, p3, p4, p5, p6, p7
                            )
                    except Exception as e:
                        logger.error(f"Failed to send command {command}: {e}")

                    # Determine initial timeout
                    timeout_duration = 5.0 if command == 400 else 3.0
                    deadline = time.time() + timeout_duration
                    
                    command_completed = False
                    final_result = None

                    while time.time() < deadline:
                        ack_data = self._pending_acks.get(ack_key)
                        if ack_data is not None:
                            # Clear the ACK so we don't read it twice if we get IN_PROGRESS
                            self._pending_acks[ack_key] = None
                            
                            res = ack_data["result"]
                            if res == mavutil.mavlink.MAV_RESULT_IN_PROGRESS:
                                # Extend the deadline
                                deadline = time.time() + timeout_duration
                                await asyncio.sleep(0.1)
                                continue
                            else:
                                final_result = res
                                command_completed = True
                                break
                                
                        await asyncio.sleep(0.05)
                    
                    if command_completed:
                        ok = final_result == mavutil.mavlink.MAV_RESULT_ACCEPTED
                        if not ok:
                            logger.warning(f"Command {command} rejected with result {final_result}")
                        
                        ret = {
                            "accepted": ok,
                            "mav_result": int(final_result),
                            "mav_result_text": mav_result_text(int(final_result)),
                            "reason": "mavlink" if not ok else "accepted",
                            "command": int(command),
                        }
                        self._active_commands[sysid]["is_executing"] = False
                        self._active_commands[sysid]["result_text"] = ret["mav_result_text"]
                        return ret
                    
                    logger.warning(f"Command {command} timeout, retrying {attempt + 1}/{retries}...")
                
                # If we exit the loop, we timed out
                self._active_commands[sysid]["is_executing"] = False
                self._active_commands[sysid]["result_text"] = "TIMEOUT"
                return {
                    "accepted": False,
                    "mav_result": -1,
                    "mav_result_text": "TIMEOUT",
                    "reason": "timeout",
                    "command": int(command),
                }

            finally:
                if ack_key in self._pending_acks:
                    del self._pending_acks[ack_key]
                # Keep the last command status in the dict for a bit so frontend can see it completed

    def to_status(self) -> Dict[str, Any]:
        """Exposes the command engine state for all vehicles."""
        return self._active_commands

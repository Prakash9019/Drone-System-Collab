import asyncio
import collections
import logging
import time
import uuid
from pymavlink import mavutil
from typing import List, Optional
from mission_models import MissionItem

logger = logging.getLogger(__name__)

class MissionManager:
    def __init__(self, link_manager):
        self.lm = link_manager
        # Queue to receive mission-specific messages from the main read loop
        self.message_queue = asyncio.Queue()
        self.mission_history = collections.deque(maxlen=50)
        self.vehicle_versions = {}
        self.transfer_status = {
            "session_id": None,
            "phase": "IDLE",
            "mission_type": "MISSION",
            "direction": None,  # upload|download|clear
            "total": 0,
            "current": 0,
            "ok": None,
            "last_ack": None,
            "error": "",
            "updated_at": 0.0,
            "mission_version": None,
            "duration_s": 0.0,
            "retries": 0,
        }

    def _commit_history(self):
        st = self.transfer_status
        if st.get("phase") in ("DONE", "FAILED") and st.get("session_id"):
            self.mission_history.append({
                "session_id": st["session_id"],
                "timestamp": st["updated_at"],
                "direction": st["direction"],
                "mission_type": st["mission_type"],
                "mission_hash": st["mission_version"],
                "item_count": st["total"] if st["direction"] in ("download", "clear") else st["current"],
                "total_retries": st["retries"],
                "duration_s": st["duration_s"],
                "ok": st["ok"],
                "ack_result": st["last_ack"],
                "failure_reason": st["error"]
            })
            if st.get("ok") and st.get("mission_version") and self.lm.primary_sysid:
                self.vehicle_versions[self.lm.primary_sysid] = st["mission_version"]

    def validate_mission(self, items: List[MissionItem]) -> bool:
        for item in items:
            if item.lat != 0.0 or item.lng != 0.0:
                if not (-90.0 <= item.lat <= 90.0) or not (-180.0 <= item.lng <= 180.0):
                    return False
        return True

    async def clear_mission(self, mission_type: str = "MISSION") -> bool:
        if not self.lm.conn or not self.lm.primary_sysid:
            return False
        
        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav
        mission_type_value = self._mission_type_value(mission_type)

        self.clear_queue()
        session_id = uuid.uuid4().hex
        start_time = time.time()
        self._set_transfer(
            session_id=session_id,
            phase="CLEARING",
            direction="clear",
            mission_type=mission_type.upper(),
            total=0,
            current=0,
            ok=None,
            error="",
            last_ack=None,
            retries=0,
            duration_s=0.0
        )
        retries = 0
        for attempt in range(3):
            if attempt > 0: retries += 1
            mav.mission_clear_all_send(sysid, compid, mission_type_value)
            ack = await self.wait_for_message(['MISSION_ACK'], timeout=1.0, expected_mission_type=mission_type_value)
            if ack and ack.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                self._set_transfer(mission_version=uuid.uuid4().hex[:8], phase="DONE", ok=True, duration_s=time.time() - start_time, retries=retries)
                self._commit_history()
                return True
        self._set_transfer(phase="FAILED", ok=False, error="clear_timeout", duration_s=time.time() - start_time, retries=retries)
        self._commit_history()
        return False

    def _set_transfer(self, **patch):
        self.transfer_status = {**self.transfer_status, **patch, "updated_at": asyncio.get_event_loop().time()}

    def handle_mission_message(self, msg):
        """Called by LinkManager when a mission-related message arrives."""
        try:
            self.message_queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass

    def _mission_type_value(self, mission_type: str) -> int:
        mission_type = (mission_type or "MISSION").upper()
        mapping = {
            "MISSION": mavutil.mavlink.MAV_MISSION_TYPE_MISSION,
            "FENCE": mavutil.mavlink.MAV_MISSION_TYPE_FENCE,
            "RALLY": mavutil.mavlink.MAV_MISSION_TYPE_RALLY,
        }
        return mapping.get(mission_type, mavutil.mavlink.MAV_MISSION_TYPE_MISSION)

    async def wait_for_message(self, msg_types: List[str], timeout: float = 1.0, expected_mission_type: int | None = None):
        """Wait for specific message types from the queue."""
        end_time = asyncio.get_event_loop().time() + timeout
        while True:
            if not self.lm.conn or self.lm.connection_state.value == "DISCONNECTED":
                st = self.transfer_status
                if st.get("phase") not in ("DONE", "FAILED", "IDLE"):
                    self._set_transfer(phase="FAILED", ok=False, error="link_disconnected")
                    self._commit_history()
                return None
            time_left = end_time - asyncio.get_event_loop().time()
            if time_left <= 0:
                return None
            try:
                msg = await asyncio.wait_for(self.message_queue.get(), timeout=time_left)
                if msg.get_type() in msg_types:
                    if expected_mission_type is not None and hasattr(msg, "mission_type"):
                        if int(msg.mission_type) != int(expected_mission_type):
                            continue
                    return msg
            except asyncio.TimeoutError:
                return None

    def clear_queue(self):
        while not self.message_queue.empty():
            self.message_queue.get_nowait()

    def _inject_home(self, items: List[MissionItem]) -> List[MissionItem]:
        """Inject HOME waypoint at seq=0 (ArduPilot requirement for missions)."""
        if not items:
            return items
        first = items[0]
        # If first item is already a HOME-style waypoint (absolute frame, seq=0, WAYPOINT cmd)
        if first.seq == 0 and first.command == 16 and first.frame in (0, 6):
            return items
        # Build HOME from vehicle home position if available
        home_lat, home_lng, home_alt = 0.0, 0.0, 0.0
        if self.lm.primary_sysid in self.lm.vehicles:
            h = self.lm.vehicles[self.lm.primary_sysid].home
            if getattr(h, 'valid', False):
                home_lat, home_lng, home_alt = h.lat, h.lng, h.alt_m
        home_item = MissionItem(
            seq=0, frame=0, command=16,  # MAV_FRAME_GLOBAL, MAV_CMD_NAV_WAYPOINT
            current=0, autocontinue=1,
            param1=0.0, param2=0.0, param3=0.0, param4=0.0,
            lat=home_lat, lng=home_lng, alt=home_alt,
        )
        renumbered = [
            MissionItem(**{**item.model_dump(), 'seq': i + 1})
            for i, item in enumerate(items)
        ]
        return [home_item] + renumbered

    async def upload_mission(self, items: List[MissionItem], mission_type: str = "MISSION") -> bool:
        """Uploads a mission to the drone using the MAVLink mission protocol."""
        session_id = uuid.uuid4().hex
        start_time = time.time()
        if not self.validate_mission(items):
            logger.error("Mission upload failed: Waypoint validation failed (out of bounds lat/lng).")
            self._set_transfer(
                session_id=session_id,
                phase="FAILED",
                direction="upload",
                mission_type=mission_type.upper(),
                ok=False,
                error="validation_failed",
                duration_s=time.time() - start_time,
            )
            self._commit_history()
            return False

        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot upload mission: no connection.")
            self._set_transfer(
                session_id=session_id,
                phase="FAILED",
                direction="upload",
                mission_type=mission_type.upper(),
                ok=False,
                error="no_connection",
                duration_s=time.time() - start_time,
            )
            self._commit_history()
            return False

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav
        mission_type_value = self._mission_type_value(mission_type)

        # Inject HOME at seq=0 for ArduPilot missions (MP always does this)
        if mission_type.upper() == "MISSION":
            items = self._inject_home(items)

        self.clear_queue()
        logger.info(f"Starting upload of {len(items)} {mission_type} items (with HOME)...")
        self._set_transfer(
            session_id=session_id,
            phase="SENDING_COUNT",
            direction="upload",
            mission_type=mission_type.upper(),
            total=len(items),
            current=0,
            ok=None,
            error="",
            last_ack=None,
            retries=0,
            duration_s=0.0
        )

        retries = 0
        # 1. Send MISSION_COUNT — retry 3 times at 1.0s each
        for attempt in range(3):
            if attempt > 0: retries += 1
            mav.mission_count_send(sysid, compid, len(items), mission_type_value)
            req = await self.wait_for_message(
                ['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'],
                timeout=1.0, expected_mission_type=mission_type_value)
            if req:
                break
        else:
            logger.error("Mission upload failed: No MISSION_REQUEST_INT received.")
            self._set_transfer(phase="FAILED", ok=False, error="no_request_after_count", duration_s=time.time() - start_time, retries=retries)
            self._commit_history()
            return False

        if req.get_type() == 'MISSION_ACK':
            logger.error(f"Mission upload rejected immediately: {req}")
            self._set_transfer(phase="FAILED", ok=False, error="ack_rejected_after_count", last_ack=int(getattr(req, "type", -1)), duration_s=time.time() - start_time, retries=retries)
            self._commit_history()
            return False

        # 2. Upload each item — 10 retries at 0.45s each (matches MP setWPAsync)
        seq_to_send = req.seq
        self._set_transfer(phase="UPLOADING_ITEMS", current=int(seq_to_send))
        while seq_to_send < len(items):
            item = items[seq_to_send]
            item_sent = False
            for attempt in range(10):
                if attempt > 0: retries += 1
                mav.mission_item_int_send(
                    sysid, compid,
                    item.seq,
                    item.frame,
                    item.command,
                    item.current,
                    item.autocontinue,
                    item.param1, item.param2, item.param3, item.param4,
                    int(item.lat * 1e7), int(item.lng * 1e7), item.alt,
                    mission_type_value
                )
                msg = await self.wait_for_message(
                    ['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'],
                    timeout=0.45, expected_mission_type=mission_type_value)
                if msg:
                    if msg.get_type() in ('MISSION_REQUEST_INT', 'MISSION_REQUEST'):
                        seq_to_send = msg.seq
                        self._set_transfer(current=int(min(max(seq_to_send, 0), len(items))), retries=retries)
                        item_sent = True
                        break
                    elif msg.get_type() == 'MISSION_ACK':
                        ack_type = int(getattr(msg, 'type', -1))
                        if ack_type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                            logger.info("Mission upload successful!")
                            self._set_transfer(phase="DONE", ok=True, current=len(items), last_ack=ack_type, error="", mission_version=uuid.uuid4().hex[:8], duration_s=time.time() - start_time, retries=retries)
                            self._commit_history()
                            return True
                        elif ack_type == mavutil.mavlink.MAV_MISSION_INVALID_SEQUENCE:
                            # Vehicle confused about sequence — wait for it to tell us what it wants
                            logger.warning(f"MISSION_INVALID_SEQUENCE at item {seq_to_send}, waiting for vehicle REQUEST...")
                            recovery = await self.wait_for_message(
                                ['MISSION_REQUEST_INT', 'MISSION_REQUEST'],
                                timeout=1.5, expected_mission_type=mission_type_value)
                            if recovery:
                                seq_to_send = recovery.seq
                                self._set_transfer(current=int(min(max(seq_to_send, 0), len(items))), retries=retries)
                                item_sent = True
                            break  # restart the per-item loop from new seq
                        else:
                            logger.error(f"Mission upload failed with ACK type {ack_type}")
                            self._set_transfer(phase="FAILED", ok=False, current=int(seq_to_send), last_ack=ack_type, error="ack_rejected", duration_s=time.time() - start_time, retries=retries)
                            self._commit_history()
                            return False

            if not item_sent and seq_to_send >= len(items):
                break
            if not item_sent:
                logger.error(f"Mission upload failed: Timeout sending item {seq_to_send}.")
                self._set_transfer(phase="FAILED", ok=False, current=int(seq_to_send), error="item_timeout", duration_s=time.time() - start_time, retries=retries)
                self._commit_history()
                return False

        # 3. Wait for final MISSION_ACK
        # It's possible the last item we sent triggered an ACK already which we missed.
        # We will wait for MISSION_ACK if not received yet
        ack = await self.wait_for_message(['MISSION_ACK'], timeout=1.0, expected_mission_type=mission_type_value)
        if ack and ack.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
            logger.info("Mission upload successful!")
            version = uuid.uuid4().hex[:8]
            self._set_transfer(phase="DONE", ok=True, current=len(items), last_ack=int(ack.type), error="", mission_version=version, duration_s=time.time() - start_time, retries=retries)
            self._commit_history()
            return True
        else:
            logger.error(f"Mission upload failed: Bad ACK or timeout. {ack}")
            self._set_transfer(
                phase="FAILED",
                ok=False,
                current=len(items),
                last_ack=int(ack.type) if ack and hasattr(ack, "type") else None,
                error="final_ack_timeout_or_reject",
                duration_s=time.time() - start_time,
                retries=retries
            )
            self._commit_history()
            return False

    async def download_mission(self, mission_type: str = "MISSION") -> List[MissionItem]:
        """Downloads the current mission from the drone."""
        session_id = uuid.uuid4().hex
        start_time = time.time()
        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot download mission: no connection.")
            self._set_transfer(
                session_id=session_id,
                phase="FAILED",
                direction="download",
                mission_type=mission_type.upper(),
                ok=False,
                error="no_connection",
                duration_s=time.time() - start_time,
            )
            self._commit_history()
            return []

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav
        mission_type_value = self._mission_type_value(mission_type)

        self.clear_queue()
        logger.info(f"Starting {mission_type} download...")
        self._set_transfer(
            session_id=session_id,
            phase="REQUESTING_LIST",
            direction="download",
            mission_type=mission_type.upper(),
            total=0,
            current=0,
            ok=None,
            error="",
            last_ack=None,
            retries=0,
            duration_s=0.0
        )

        retries = 0
        # 1. Request List — 6 retries at 0.7s (matches MP getWPCountAsync: 6 retries × 700ms)
        for attempt in range(6):
            if attempt > 0: retries += 1
            mav.mission_request_list_send(sysid, compid, mission_type_value)
            count_msg = await self.wait_for_message(['MISSION_COUNT'], timeout=0.7, expected_mission_type=mission_type_value)
            if count_msg:
                break
        else:
            logger.error("Mission download failed: No MISSION_COUNT received.")
            self._set_transfer(phase="FAILED", ok=False, error="no_mission_count", duration_s=time.time() - start_time, retries=retries)
            self._commit_history()
            return []

        count = count_msg.count
        self._set_transfer(phase="DOWNLOADING_ITEMS", total=int(count), current=0)
        if count == 0:
            logger.info("Mission is empty.")
            mav.mission_ack_send(sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mission_type_value)
            self._set_transfer(phase="DONE", ok=True, total=0, current=0, last_ack=int(mavutil.mavlink.MAV_MISSION_ACCEPTED), error="", duration_s=time.time() - start_time, retries=retries)
            self._commit_history()
            return []

        items = []
        # 2. Download items — 5 retries at 2.5s each (matches MP getWPAsync: 5 retries × 2500ms)
        for seq in range(count):
            for attempt in range(5):
                if attempt > 0: retries += 1
                mav.mission_request_int_send(sysid, compid, seq, mission_type_value)
                item_msg = await self.wait_for_message(
                    ['MISSION_ITEM_INT', 'MISSION_ITEM'], timeout=2.5, expected_mission_type=mission_type_value)
                if item_msg and item_msg.seq == seq:
                    is_int = item_msg.get_type() == "MISSION_ITEM_INT"
                    raw_x = float(getattr(item_msg, "x", 0.0))
                    raw_y = float(getattr(item_msg, "y", 0.0))
                    item = MissionItem(
                        seq=item_msg.seq,
                        frame=item_msg.frame,
                        command=item_msg.command,
                        current=item_msg.current,
                        autocontinue=item_msg.autocontinue,
                        param1=item_msg.param1,
                        param2=item_msg.param2,
                        param3=item_msg.param3,
                        param4=item_msg.param4,
                        # MISSION_ITEM_INT encodes x/y in 1e7-scaled ints, while
                        # MISSION_ITEM uses x/y as float degrees directly.
                        lat=(raw_x / 1e7) if is_int else raw_x,
                        lng=(raw_y / 1e7) if is_int else raw_y,
                        alt=item_msg.z
                    )
                    # Handle duplicate packets by ensuring we don't append the same seq multiple times
                    if seq == len(items):
                        items.append(item)
                    self._set_transfer(current=int(seq + 1), retries=retries)
                    break
            else:
                logger.error(f"Mission download failed at seq {seq}.")
                self._set_transfer(phase="FAILED", ok=False, current=int(seq), error="item_timeout", duration_s=time.time() - start_time, retries=retries)
                self._commit_history()
                return []

        # 3. Send final ACK
        mav.mission_ack_send(
            sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mission_type_value
        )
        logger.info(f"Successfully downloaded {len(items)} items.")
        version = uuid.uuid4().hex[:8]
        self._set_transfer(
            phase="DONE",
            ok=True,
            total=int(count),
            current=int(len(items)),
            last_ack=int(mavutil.mavlink.MAV_MISSION_ACCEPTED),
            error="",
            mission_version=version,
            duration_s=time.time() - start_time,
            retries=retries
        )
        self._commit_history()
        return items

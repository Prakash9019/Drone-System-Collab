import asyncio
import logging
from pymavlink import mavutil
from typing import List, Optional
from mission_models import MissionItem

logger = logging.getLogger(__name__)

class MissionManager:
    def __init__(self, link_manager):
        self.lm = link_manager
        # Queue to receive mission-specific messages from the main read loop
        self.message_queue = asyncio.Queue()
        self.transfer_status = {
            "phase": "IDLE",
            "mission_type": "MISSION",
            "direction": None,  # upload|download
            "total": 0,
            "current": 0,
            "ok": None,
            "last_ack": None,
            "error": "",
            "updated_at": 0.0,
        }

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

    async def upload_mission(self, items: List[MissionItem], mission_type: str = "MISSION") -> bool:
        """Uploads a mission to the drone using the MAVLink mission protocol."""
        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot upload mission: no connection.")
            self._set_transfer(
                phase="FAILED",
                direction="upload",
                mission_type=mission_type.upper(),
                ok=False,
                error="no_connection",
            )
            return False

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav
        mission_type_value = self._mission_type_value(mission_type)

        self.clear_queue()
        logger.info(f"Starting upload of {len(items)} {mission_type} items...")
        self._set_transfer(
            phase="SENDING_COUNT",
            direction="upload",
            mission_type=mission_type.upper(),
            total=len(items),
            current=0,
            ok=None,
            error="",
            last_ack=None,
        )

        # 1. Send MISSION_COUNT
        for attempt in range(3):
            mav.mission_count_send(
                sysid, compid, len(items),
                mission_type_value
            )
            req = await self.wait_for_message(['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'], timeout=1.0, expected_mission_type=mission_type_value)
            if req:
                break
        else:
            logger.error("Mission upload failed: No MISSION_REQUEST_INT received.")
            self._set_transfer(phase="FAILED", ok=False, error="no_request_after_count")
            return False

        if req.get_type() == 'MISSION_ACK':
            logger.error(f"Mission upload rejected immediately: {req}")
            self._set_transfer(phase="FAILED", ok=False, error="ack_rejected_after_count", last_ack=int(getattr(req, "type", -1)))
            return False

        # 2. Upload each item
        seq_to_send = req.seq
        self._set_transfer(phase="UPLOADING_ITEMS", current=int(seq_to_send))
        while seq_to_send < len(items):
            item = items[seq_to_send]
            for attempt in range(3):
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
                
                # Wait for next request or final ack
                msg = await self.wait_for_message(['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'], timeout=1.0, expected_mission_type=mission_type_value)
                if msg:
                    if msg.get_type() in ('MISSION_REQUEST_INT', 'MISSION_REQUEST'):
                        seq_to_send = msg.seq
                        self._set_transfer(current=int(min(max(seq_to_send, 0), len(items))))
                        break
                    elif msg.get_type() == 'MISSION_ACK':
                        if msg.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                            logger.info("Mission upload successful!")
                            self._set_transfer(phase="DONE", ok=True, current=len(items), last_ack=int(msg.type), error="")
                            return True
                        else:
                            logger.error(f"Mission upload failed: {msg}")
                            self._set_transfer(phase="FAILED", ok=False, current=int(seq_to_send), last_ack=int(msg.type), error="ack_rejected")
                            return False
                
            else:
                logger.error(f"Mission upload failed: Timeout sending item {seq_to_send}.")
                self._set_transfer(phase="FAILED", ok=False, current=int(seq_to_send), error="item_timeout")
                return False

        # 3. Wait for final MISSION_ACK
        # It's possible the last item we sent triggered an ACK already which we missed.
        # We will wait for MISSION_ACK if not received yet
        ack = await self.wait_for_message(['MISSION_ACK'], timeout=1.0, expected_mission_type=mission_type_value)
        if ack and ack.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
            logger.info("Mission upload successful!")
            self._set_transfer(phase="DONE", ok=True, current=len(items), last_ack=int(ack.type), error="")
            return True
        else:
            logger.error(f"Mission upload failed: Bad ACK or timeout. {ack}")
            self._set_transfer(
                phase="FAILED",
                ok=False,
                current=len(items),
                last_ack=int(ack.type) if ack and hasattr(ack, "type") else None,
                error="final_ack_timeout_or_reject",
            )
            return False

    async def download_mission(self, mission_type: str = "MISSION") -> List[MissionItem]:
        """Downloads the current mission from the drone."""
        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot download mission: no connection.")
            self._set_transfer(
                phase="FAILED",
                direction="download",
                mission_type=mission_type.upper(),
                ok=False,
                error="no_connection",
            )
            return []

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav
        mission_type_value = self._mission_type_value(mission_type)

        self.clear_queue()
        logger.info(f"Starting {mission_type} download...")
        self._set_transfer(
            phase="REQUESTING_LIST",
            direction="download",
            mission_type=mission_type.upper(),
            total=0,
            current=0,
            ok=None,
            error="",
            last_ack=None,
        )

        # 1. Request List
        for attempt in range(3):
            mav.mission_request_list_send(
                sysid, compid, mission_type_value
            )
            count_msg = await self.wait_for_message(['MISSION_COUNT'], timeout=0.5, expected_mission_type=mission_type_value)
            if count_msg:
                break
        else:
            logger.error("Mission download failed: No MISSION_COUNT received.")
            self._set_transfer(phase="FAILED", ok=False, error="no_mission_count")
            return []

        count = count_msg.count
        self._set_transfer(phase="DOWNLOADING_ITEMS", total=int(count), current=0)
        if count == 0:
            logger.info("Mission is empty.")
            # Send ACK
            mav.mission_ack_send(sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mission_type_value)
            self._set_transfer(phase="DONE", ok=True, total=0, current=0, last_ack=int(mavutil.mavlink.MAV_MISSION_ACCEPTED), error="")
            return []

        items = []
        # 2. Download items
        for seq in range(count):
            for attempt in range(3):
                mav.mission_request_int_send(
                    sysid, compid, seq, mission_type_value
                )
                item_msg = await self.wait_for_message(['MISSION_ITEM_INT', 'MISSION_ITEM'], timeout=1.0, expected_mission_type=mission_type_value)
                if item_msg and item_msg.seq == seq:
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
                        lat=(item_msg.x / 1e7) if hasattr(item_msg, 'x') else item_msg.x,
                        lng=(item_msg.y / 1e7) if hasattr(item_msg, 'y') else item_msg.y,
                        alt=item_msg.z
                    )
                    items.append(item)
                    self._set_transfer(current=int(seq + 1))
                    break
            else:
                logger.error(f"Mission download failed at seq {seq}.")
                self._set_transfer(phase="FAILED", ok=False, current=int(seq), error="item_timeout")
                return []

        # 3. Send final ACK
        mav.mission_ack_send(
            sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mission_type_value
        )
        logger.info(f"Successfully downloaded {len(items)} items.")
        self._set_transfer(
            phase="DONE",
            ok=True,
            total=int(count),
            current=int(len(items)),
            last_ack=int(mavutil.mavlink.MAV_MISSION_ACCEPTED),
            error="",
        )
        return items

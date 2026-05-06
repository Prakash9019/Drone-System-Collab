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

    def handle_mission_message(self, msg):
        """Called by LinkManager when a mission-related message arrives."""
        try:
            self.message_queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass

    async def wait_for_message(self, msg_types: List[str], timeout: float = 1.0):
        """Wait for specific message types from the queue."""
        end_time = asyncio.get_event_loop().time() + timeout
        while True:
            time_left = end_time - asyncio.get_event_loop().time()
            if time_left <= 0:
                return None
            try:
                msg = await asyncio.wait_for(self.message_queue.get(), timeout=time_left)
                if msg.get_type() in msg_types:
                    return msg
            except asyncio.TimeoutError:
                return None

    def clear_queue(self):
        while not self.message_queue.empty():
            self.message_queue.get_nowait()

    async def upload_mission(self, items: List[MissionItem]) -> bool:
        """Uploads a mission to the drone using the MAVLink mission protocol."""
        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot upload mission: no connection.")
            return False

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav

        self.clear_queue()
        logger.info(f"Starting upload of {len(items)} mission items...")

        # 1. Send MISSION_COUNT
        for attempt in range(3):
            mav.mission_count_send(
                sysid, compid, len(items),
                mavutil.mavlink.MAV_MISSION_TYPE_MISSION
            )
            req = await self.wait_for_message(['MISSION_REQUEST_INT', 'MISSION_ACK'], timeout=0.5)
            if req:
                break
        else:
            logger.error("Mission upload failed: No MISSION_REQUEST_INT received.")
            return False

        if req.get_type() == 'MISSION_ACK':
            logger.error(f"Mission upload rejected immediately: {req}")
            return False

        # 2. Upload each item
        seq_to_send = req.seq
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
                    mavutil.mavlink.MAV_MISSION_TYPE_MISSION
                )
                
                # Wait for next request or final ack
                msg = await self.wait_for_message(['MISSION_REQUEST_INT', 'MISSION_ACK'], timeout=0.5)
                if msg:
                    if msg.get_type() == 'MISSION_REQUEST_INT':
                        seq_to_send = msg.seq
                        break
                    elif msg.get_type() == 'MISSION_ACK':
                        if msg.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                            logger.info("Mission upload successful!")
                            return True
                        else:
                            logger.error(f"Mission upload failed: {msg}")
                            return False
                
            else:
                logger.error(f"Mission upload failed: Timeout sending item {seq_to_send}.")
                return False

        # 3. Wait for final MISSION_ACK
        # It's possible the last item we sent triggered an ACK already which we missed.
        # We will wait for MISSION_ACK if not received yet
        ack = await self.wait_for_message(['MISSION_ACK'], timeout=1.0)
        if ack and ack.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
            logger.info("Mission upload successful!")
            return True
        else:
            logger.error(f"Mission upload failed: Bad ACK or timeout. {ack}")
            return False

    async def download_mission(self) -> List[MissionItem]:
        """Downloads the current mission from the drone."""
        if not self.lm.conn or not self.lm.primary_sysid:
            logger.error("Cannot download mission: no connection.")
            return []

        sysid = self.lm.primary_sysid
        compid = self.lm.primary_compid
        mav = self.lm.conn.mav

        self.clear_queue()
        logger.info("Starting mission download...")

        # 1. Request List
        for attempt in range(3):
            mav.mission_request_list_send(
                sysid, compid, mavutil.mavlink.MAV_MISSION_TYPE_MISSION
            )
            count_msg = await self.wait_for_message(['MISSION_COUNT'], timeout=0.5)
            if count_msg:
                break
        else:
            logger.error("Mission download failed: No MISSION_COUNT received.")
            return []

        count = count_msg.count
        if count == 0:
            logger.info("Mission is empty.")
            # Send ACK
            mav.mission_ack_send(sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
            return []

        items = []
        # 2. Download items
        for seq in range(count):
            for attempt in range(3):
                mav.mission_request_int_send(
                    sysid, compid, seq, mavutil.mavlink.MAV_MISSION_TYPE_MISSION
                )
                item_msg = await self.wait_for_message(['MISSION_ITEM_INT'], timeout=0.5)
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
                        lat=item_msg.x / 1e7,
                        lng=item_msg.y / 1e7,
                        alt=item_msg.z
                    )
                    items.append(item)
                    break
            else:
                logger.error(f"Mission download failed at seq {seq}.")
                return []

        # 3. Send final ACK
        mav.mission_ack_send(
            sysid, compid, mavutil.mavlink.MAV_MISSION_ACCEPTED, mavutil.mavlink.MAV_MISSION_TYPE_MISSION
        )
        logger.info(f"Successfully downloaded {len(items)} items.")
        return items

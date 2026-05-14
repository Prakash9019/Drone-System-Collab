import os
import json
import uuid
import time
import asyncio
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

class ReplayManager:
    """
    Manages recording live ZMQ telemetry to .jsonl files and playing it back
    into the ZMQ stream with a replay flag.
    """
    def __init__(self, publish_callback):
        self.publish_callback = publish_callback
        self.recordings_dir = os.path.join(os.path.dirname(__file__), "recordings")
        os.makedirs(self.recordings_dir, exist_ok=True)
        
        self.is_recording = False
        self.recording_session_id: Optional[str] = None
        self.recording_file = None
        self._record_start_time = 0.0
        
        self.is_playing = False
        self.is_paused = False
        self.playback_session_id: Optional[str] = None
        self._playback_task: Optional[asyncio.Task] = None
        
        self._events: list = []
        self._current_index = 0
        self._playback_speed = 1.0
        self._playback_duration = 0.0
        self._seek_flag = False
        
    def start_recording(self) -> str:
        if self.is_recording:
            return self.recording_session_id
            
        self.recording_session_id = str(uuid.uuid4())
        filepath = os.path.join(self.recordings_dir, f"{self.recording_session_id}.jsonl")
        self.recording_file = open(filepath, 'a')
        self.is_recording = True
        self._record_start_time = time.time()
        logger.info(f"Started recording telemetry session: {self.recording_session_id}")
        return self.recording_session_id
        
    def stop_recording(self):
        if not self.is_recording:
            return
        self.is_recording = False
        if self.recording_file:
            self.recording_file.close()
            self.recording_file = None
        logger.info(f"Stopped recording telemetry session: {self.recording_session_id}")
        self.recording_session_id = None
        
    def record_event(self, payload: dict):
        if not self.is_recording or not self.recording_file:
            return
            
        # Do not record replay messages or replay status to avoid recursion
        if payload.get("type") == "REPLAY_STATUS" or payload.get("is_replay") is True:
            return
            
        record = {
            "time": time.time() - self._record_start_time,
            "payload": payload
        }
        self.recording_file.write(json.dumps(record) + "\n")
        self.recording_file.flush()

    def list_sessions(self) -> list:
        sessions = []
        for filename in os.listdir(self.recordings_dir):
            if filename.endswith(".jsonl"):
                session_id = filename[:-6]
                filepath = os.path.join(self.recordings_dir, filename)
                size = os.path.getsize(filepath)
                sessions.append({"session_id": session_id, "size_bytes": size})
        return sessions

    async def start_playback(self, session_id: str):
        if self.is_playing:
            await self.stop_playback()
            
        filepath = os.path.join(self.recordings_dir, f"{session_id}.jsonl")
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Recording {session_id} not found.")
            
        self._events = []
        with open(filepath, 'r') as f:
            for line in f:
                try:
                    self._events.append(json.loads(line))
                except Exception:
                    pass
                    
        if not self._events:
            raise ValueError("Recording is empty.")
            
        self._playback_duration = self._events[-1]["time"]
        self.playback_session_id = session_id
        self.is_playing = True
        self.is_paused = False
        self._current_index = 0
        self._seek_flag = False
        
        self._playback_task = asyncio.create_task(self._playback_loop())
        logger.info(f"Started playback for session: {session_id}")

    async def stop_playback(self):
        self.is_playing = False
        if self._playback_task:
            self._playback_task.cancel()
            try:
                await self._playback_task
            except asyncio.CancelledError:
                pass
            self._playback_task = None
        self.playback_session_id = None
        self._events = []
        await self._broadcast_status()

    def pause_playback(self):
        self.is_paused = True

    def resume_playback(self):
        self.is_paused = False

    def seek_playback(self, time_s: float):
        if not self._events: return
        time_s = max(0.0, min(time_s, self._playback_duration))
        
        # Find index closest to time_s
        idx = 0
        for i, ev in enumerate(self._events):
            if ev["time"] >= time_s:
                idx = i
                break
        self._current_index = idx
        self._seek_flag = True

    async def _broadcast_status(self):
        progress = 0.0
        if self._events and self._current_index < len(self._events):
            progress = self._events[self._current_index]["time"]
            
        payload = {
            "type": "REPLAY_STATUS",
            "data": {
                "is_recording": self.is_recording,
                "recording_session_id": self.recording_session_id,
                "is_playing": self.is_playing,
                "is_paused": self.is_paused,
                "playback_session_id": self.playback_session_id,
                "progress_s": progress,
                "duration_s": self._playback_duration,
                "speed": self._playback_speed
            }
        }
        await self.publish_callback(payload)

    async def _playback_loop(self):
        try:
            last_event_time = 0.0
            last_wall_time = time.time()
            
            while self.is_playing and self._current_index < len(self._events):
                await self._broadcast_status()
                
                if self.is_paused:
                    await asyncio.sleep(0.5)
                    last_wall_time = time.time()
                    continue
                    
                if self._seek_flag:
                    self._seek_flag = False
                    if self._current_index < len(self._events):
                        last_event_time = self._events[self._current_index]["time"]
                    last_wall_time = time.time()
                    continue

                event = self._events[self._current_index]
                event_time = event["time"]
                payload = event["payload"]
                
                # Sleep if necessary to match timeline
                if last_event_time > 0:
                    delta_event = event_time - last_event_time
                    delta_event /= self._playback_speed
                    now = time.time()
                    delta_wall = now - last_wall_time
                    
                    sleep_time = delta_event - delta_wall
                    if sleep_time > 0:
                        await asyncio.sleep(sleep_time)
                        
                # Inject replay flag
                payload["is_replay"] = True
                await self.publish_callback(payload)
                
                last_event_time = event_time
                last_wall_time = time.time()
                self._current_index += 1

            # End of playback
            self.is_playing = False
            await self._broadcast_status()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Playback loop error: {e}")
            self.is_playing = False

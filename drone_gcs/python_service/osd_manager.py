import json
import os
import time


class OSDProfileManager:
    def __init__(self):
        self.path = os.path.join(os.path.dirname(__file__), "osd_profiles.json")

    def _read(self):
        if not os.path.exists(self.path):
            return {}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _write(self, profiles):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=2)

    def list_profiles(self):
        return self._read()

    def save_profile(self, profile_id: str, payload: dict):
        profiles = self._read()
        payload = dict(payload or {})
        payload["updated_at"] = time.time()
        profiles[profile_id] = payload
        self._write(profiles)
        return {"status": "saved", "profile_id": profile_id}

    def delete_profile(self, profile_id: str):
        profiles = self._read()
        if profile_id in profiles:
            del profiles[profile_id]
            self._write(profiles)
            return {"status": "deleted", "profile_id": profile_id}
        return {"status": "not_found", "profile_id": profile_id}

from pydantic import BaseModel

class MissionItem(BaseModel):
    seq: int
    frame: int
    command: int
    current: int = 0
    autocontinue: int = 1
    param1: float = 0.0
    param2: float = 0.0
    param3: float = 0.0
    param4: float = 0.0
    lat: float = 0.0
    lng: float = 0.0
    alt: float = 0.0

    def to_dict(self):
        return self.model_dump()

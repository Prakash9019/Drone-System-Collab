import re
from typing import Any, List, Optional
from pydantic import BaseModel, Field

WAYPOINT_HEADER = "QGC WPL 110"
LINE_PATTERN = re.compile(r"^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9\.-]+)\s+([0-9]+)\s*$")


class MissionItem(BaseModel):
    seq: int
    current: int = 0
    frame: int = Field(default=0)
    command: int = Field(default=16)
    param1: float = 0.0
    param2: float = 0.0
    param3: float = 0.0
    param4: float = 0.0
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    autocontinue: int = 1

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "current": self.current,
            "frame": self.frame,
            "command": self.command,
            "param1": self.param1,
            "param2": self.param2,
            "param3": self.param3,
            "param4": self.param4,
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "autocontinue": self.autocontinue,
        }

    @classmethod
    def from_message(cls, message: Any) -> "MissionItem":
        from pymavlink import mavutil

        msg_type = message.get_type()
        if msg_type == "MISSION_ITEM_INT":
            return cls(
                seq=message.seq,
                current=message.current,
                frame=message.frame,
                command=message.command,
                param1=message.param1,
                param2=message.param2,
                param3=message.param3,
                param4=message.param4,
                x=message.x * 1e-7,
                y=message.y * 1e-7,
                z=message.z,
                autocontinue=message.autocontinue,
            )

        if msg_type == "MISSION_ITEM":
            return cls(
                seq=message.seq,
                current=message.current,
                frame=message.frame,
                command=message.command,
                param1=message.param1,
                param2=message.param2,
                param3=message.param3,
                param4=message.param4,
                x=message.x,
                y=message.y,
                z=message.z,
                autocontinue=message.autocontinue,
            )

        raise ValueError(f"Unsupported mission message type: {msg_type}")


def load_waypoints(path: str) -> List[MissionItem]:
    items: List[MissionItem] = []
    with open(path, "r", encoding="utf-8") as fp:
        header = fp.readline().strip()
        if header != WAYPOINT_HEADER:
            raise ValueError(f"Unexpected waypoint file header: {header}")

        for line in fp:
            if not line.strip() or line.strip().startswith("#"):
                continue
            match = LINE_PATTERN.match(line)
            if not match:
                raise ValueError(f"Malformed waypoint line: {line.strip()}")

            seq, current, frame, command, param1, param2, param3, param4, x, y, z, autocontinue = match.groups()
            items.append(
                MissionItem(
                    seq=int(seq),
                    current=int(current),
                    frame=int(frame),
                    command=int(command),
                    param1=float(param1),
                    param2=float(param2),
                    param3=float(param3),
                    param4=float(param4),
                    x=float(x),
                    y=float(y),
                    z=float(z),
                    autocontinue=int(autocontinue),
                )
            )
    return items


def save_waypoints(path: str, items: List[MissionItem]) -> None:
    with open(path, "w", encoding="utf-8") as fp:
        fp.write(WAYPOINT_HEADER + "\n")
        for item in items:
            fp.write(
                f"{item.seq}\t{item.current}\t{item.frame}\t{item.command}\t"
                f"{item.param1:.6f}\t{item.param2:.6f}\t{item.param3:.6f}\t{item.param4:.6f}\t"
                f"{item.x:.7f}\t{item.y:.7f}\t{item.z:.2f}\t{item.autocontinue}\n"
            )

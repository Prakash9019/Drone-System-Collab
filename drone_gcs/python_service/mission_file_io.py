import os
import logging
from typing import List
from mission_models import MissionItem

logger = logging.getLogger(__name__)

def load_waypoints(filepath: str) -> List[MissionItem]:
    """Loads a standard QGC WPL 110 .waypoints file into MissionItems."""
    if not os.path.exists(filepath):
        logger.error(f"Waypoint file not found: {filepath}")
        return []

    items = []
    try:
        with open(filepath, 'r') as f:
            lines = f.readlines()
            
        if not lines or not lines[0].startswith("QGC WPL"):
            logger.error("Invalid waypoint file header")
            return []

        for line in lines[1:]:
            parts = line.strip().split('\t')
            if len(parts) < 12:
                continue

            item = MissionItem(
                seq=int(parts[0]),
                current=int(parts[1]),
                frame=int(parts[2]),
                command=int(parts[3]),
                param1=float(parts[4]),
                param2=float(parts[5]),
                param3=float(parts[6]),
                param4=float(parts[7]),
                lat=float(parts[8]),
                lng=float(parts[9]),
                alt=float(parts[10]),
                autocontinue=int(parts[11])
            )
            items.append(item)
    except Exception as e:
        logger.error(f"Failed to load waypoints: {e}")
        
    return items

def save_waypoints(filepath: str, items: List[MissionItem]):
    """Saves a list of MissionItems to a standard QGC WPL 110 .waypoints file."""
    try:
        with open(filepath, 'w') as f:
            f.write("QGC WPL 110\n")
            for item in items:
                line = (f"{item.seq}\t{item.current}\t{item.frame}\t{item.command}\t"
                        f"{item.param1}\t{item.param2}\t{item.param3}\t{item.param4}\t"
                        f"{item.lat}\t{item.lng}\t{item.alt}\t{item.autocontinue}\n")
                f.write(line)
        logger.info(f"Successfully saved {len(items)} waypoints to {filepath}")
    except Exception as e:
        logger.error(f"Failed to save waypoints: {e}")

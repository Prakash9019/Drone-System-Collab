import React, { useState } from 'react';
import axios from 'axios';
import useMissionStore from '../store/useMissionStore';
import MapEditor from '../components/MapEditor';
import WaypointTable from '../components/WaypointTable';
import { UploadCloud, DownloadCloud, Trash2 } from 'lucide-react';

const FlightPlanner = () => {
  const waypoints = useMissionStore((state) => state.waypoints);
  const setWaypoints = useMissionStore((state) => state.setWaypoints);
  const clearMission = useMissionStore((state) => state.clearMission);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleRead = async () => {
    setLoading(true);
    setStatusMsg('Downloading mission from drone...');
    try {
      const res = await axios.get('http://localhost:8080/api/mission');
      setWaypoints(res.data.items || []);
      setStatusMsg(`Successfully read ${res.data.items?.length || 0} waypoints.`);
    } catch (err) {
      console.error(err);
      setStatusMsg('Failed to read mission.');
    } finally {
      setLoading(false);
    }
  };

  const handleWrite = async () => {
    setLoading(true);
    setStatusMsg('Uploading mission to drone...');
    try {
      await axios.post('http://localhost:8080/api/mission/upload', { items: waypoints });
      setStatusMsg('Mission successfully uploaded!');
    } catch (err) {
      console.error(err);
      setStatusMsg('Failed to upload mission.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flight-planner">
      {/* Toolbar */}
      <div className="mission-toolbar">
        <button className="btn-toolbar" onClick={handleRead} disabled={loading}>
          <DownloadCloud size={18} />
          Read WPs
        </button>
        <button className="btn-toolbar primary" onClick={handleWrite} disabled={loading || waypoints.length === 0}>
          <UploadCloud size={18} />
          Write WPs
        </button>
        <button className="btn-toolbar danger" onClick={clearMission} disabled={loading}>
          <Trash2 size={18} />
          Clear
        </button>
        
        {statusMsg && <span className="status-msg">{statusMsg}</span>}
      </div>

      {/* Split View */}
      <div className="planner-split">
        <div className="planner-left">
          <WaypointTable />
        </div>
        <div className="planner-right">
          <MapEditor />
        </div>
      </div>
    </div>
  );
};

export default FlightPlanner;

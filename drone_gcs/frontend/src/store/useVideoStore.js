import { create } from 'zustand';
import axios from 'axios';

const API_URL = 'http://localhost:8080';

const DEFAULT_SETTINGS = {
  video_source: 'DISABLED',
  rtsp_url: '',
  udp_port: 5600,
  tcp_url: '',
  aspect_ratio: 0,
  video_fit: 'FIT_HEIGHT',
  grid_lines: false,
  recording_format: 'MP4',
  max_video_size_mb: 10240,
  enable_storage_limit: false,
  stream_enabled: true,
  disable_when_disarmed: false,
  low_latency_mode: false,
  stream_timeout_s: 8,
  frame_smoothing_enabled: false,
  // Audit fix (gap #4): were named in the plan's prose but missing from the actual
  // settings port — see VIDEO_SUBSYSTEM_PLAN_AUDIT.md.
  show_rec_control: true,
  disable_pixel_aspect_ratio: false,
};

const useVideoStore = create((set, get) => ({
  settings: DEFAULT_SETTINGS,
  state: {
    active: false,
    peer_count: 0,
    raw_peer_count: 0,
    encoding: null,
    last_buffer_age_s: null,
    gst_error: null,
    fail_count: 0,
    recording: { active: false, filepath: null, elapsed_s: null },
  },
  cameras: [],
  loading: false,
  banner: '',

  fetchSettings: async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/video/settings`);
      set({ settings: { ...DEFAULT_SETTINGS, ...data } });
    } catch (e) {
      // backend may not have video routes yet — keep defaults
    }
  },

  fetchState: async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/video/state`);
      set({ state: data, banner: data?.gst_error || '' });
    } catch {}
  },

  patchSettings: async (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    set({ loading: true });
    try {
      const { data } = await axios.put(`${API_URL}/api/video/settings`, patch);
      if (data?.settings) set({ settings: { ...DEFAULT_SETTINGS, ...data.settings } });
      set({ state: data, banner: '' });
    } catch (e) {
      set({ banner: e.response?.data?.error || e.message });
    } finally {
      set({ loading: false });
    }
  },

  startVideo: async () => {
    set({ loading: true, banner: '' });
    try {
      const { data } = await axios.post(`${API_URL}/api/video/start`);
      set({ state: data });
      if (data?.gst_error) set({ banner: data.gst_error });
    } catch (e) {
      set({ banner: e.response?.data?.error || e.message });
    } finally {
      set({ loading: false });
    }
  },

  stopVideo: async () => {
    set({ loading: true, banner: '' });
    try {
      const { data } = await axios.post(`${API_URL}/api/video/stop`);
      set({ state: data });
    } catch (e) {
      set({ banner: e.response?.data?.error || e.message });
    } finally {
      set({ loading: false });
    }
  },

  setBanner: (banner) => set({ banner }),

  startRecording: async () => {
    set({ loading: true, banner: '' });
    try {
      const { data } = await axios.post(`${API_URL}/api/video/record/start`, {
        format: get().settings.recording_format,
      });
      set((s) => ({ state: { ...s.state, recording: data } }));
      get().fetchState();
    } catch (e) {
      set({ banner: e.response?.data?.error || e.response?.data?.detail || e.message });
    } finally {
      set({ loading: false });
    }
  },

  stopRecording: async () => {
    set({ loading: true });
    try {
      const { data } = await axios.post(`${API_URL}/api/video/record/stop`);
      set((s) => ({ state: { ...s.state, recording: { ...data, elapsed_s: null } } }));
      get().fetchState();
    } catch (e) {
      set({ banner: e.response?.data?.error || e.message });
    } finally {
      set({ loading: false });
    }
  },

  takeSnapshot: async () => {
    try {
      const response = await axios.post(`${API_URL}/api/video/snapshot`, {}, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      set({ banner: e.response?.data?.detail || e.message || 'Snapshot failed' });
    }
  },

  fetchCameras: async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/cameras`);
      set({ cameras: data || [] });
    } catch {
      // camera discovery is best-effort — no MAVLink camera present is normal
    }
  },

  selectCameraStream: async (sysid, compid, streamId) => {
    try {
      await axios.post(`${API_URL}/api/cameras/${sysid}/${compid}/${streamId}/select`);
      get().fetchSettings();
    } catch (e) {
      set({ banner: e.response?.data?.error || e.message });
    }
  },
}));

export const FIT_TO_CSS = {
  FIT_WIDTH: 'contain',
  FIT_HEIGHT: 'contain',
  FILL: 'cover',
  NO_CROP: 'scale-down',
};

export default useVideoStore;

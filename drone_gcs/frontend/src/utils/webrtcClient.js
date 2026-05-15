// WebRTC peer-connection wrapper for the video subsystem.
// Direct browser ↔ Python service signaling (port 8000, not via the Node gateway).

const SIGNALING_URL = `ws://${window.location.hostname}:8000/ws/video/signaling`;

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export class VideoClient {
  constructor({ onTrack, onState, onError } = {}) {
    this.onTrack = onTrack || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.pc = null;
    this.ws = null;
    this._closed = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
  }

  async connect() {
    if (this._closed) return;
    this._cleanupSocket();
    this._cleanupPeer();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (stream) this.onTrack(stream);
    };
    pc.oniceconnectionstatechange = () => {
      this.onState(pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this._scheduleReconnect();
      }
    };

    const ws = new WebSocket(SIGNALING_URL);
    this.ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this.onState('signaling-open');
    };
    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send({ type: 'answer', sdp: answer.sdp });
      } else if (msg.type === 'ice') {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (e) {
          // candidate before remote desc — buffer attempt; benign
        }
      } else if (msg.type === 'error') {
        this.onError(msg.message || 'signaling error');
        this.close();
      }
    };
    ws.onerror = () => this.onError('signaling websocket error');
    ws.onclose = () => {
      if (!this._closed) this._scheduleReconnect();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._send({
          type: 'ice',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid,
          },
        });
      }
    };
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = Math.min(8000, 500 * 2 ** this._reconnectAttempts);
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => this._scheduleReconnect());
    }, delay);
  }

  _cleanupSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  _cleanupPeer() {
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._cleanupSocket();
    this._cleanupPeer();
  }
}

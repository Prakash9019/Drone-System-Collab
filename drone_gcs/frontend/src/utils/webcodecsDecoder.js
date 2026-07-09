// WebCodecs fallback client — decodes raw H.264 Annex-B access units pulled from
// /ws/video/raw directly in the browser (no WebRTC, no jitter buffer), for the
// lowest-latency FPV path on a supporting browser (Chrome/Edge/Safari 16.4+), or
// as a fallback when webrtcbin/ICE isn't viable.
//
// Wire format (see python_service/video_service/raw_ws_sender.py):
//   each binary WS message = [timestamp_us: u64 big-endian][one encoded access
//   unit, Annex-B start-code delimited — SPS/PPS in-band on every keyframe].

const RAW_WS_URL = `ws://${window.location.hostname}:8000/ws/video/raw`;

export class WebCodecsClient {
  constructor({ canvas, onState, onError, codec = 'avc1.42E01E' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.codec = codec;
    this.ws = null;
    this.decoder = null;
    this._closed = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._configured = false;
  }

  async connect() {
    if (this._closed) return;
    if (typeof window.VideoDecoder === 'undefined') {
      this.onError('WebCodecs API not supported in this browser');
      return;
    }
    this._cleanupSocket();
    this._cleanupDecoder();

    this.decoder = new window.VideoDecoder({
      output: (frame) => this._renderFrame(frame),
      error: (e) => {
        this.onError(`decoder error: ${e.message}`);
        this._scheduleReconnect();
      },
    });

    const ws = new WebSocket(RAW_WS_URL);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this.onState('connected');
    };
    ws.onmessage = (event) => this._onFrame(event.data);
    ws.onerror = () => this.onError('raw video websocket error');
    ws.onclose = () => {
      if (!this._closed) this._scheduleReconnect();
    };
  }

  _onFrame(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength <= 8) return;
    const view = new DataView(buf);
    const timestampUs = Number(view.getBigUint64(0, false));
    const payload = new Uint8Array(buf, 8);
    const isKeyframe = _looksLikeH264Keyframe(payload);

    if (!this._configured) {
      // Only (re)configure on a keyframe — SPS/PPS are guaranteed in-band there,
      // and mid-GOP configure attempts would just fail repeatedly until the next one.
      if (!isKeyframe) return;
      try {
        this.decoder.configure({
          codec: this.codec,
          codedWidth: this.canvas?.width || 1280,
          codedHeight: this.canvas?.height || 720,
          avc: { format: 'annexb' },
          optimizeForLatency: true,
        });
        this._configured = true;
      } catch (e) {
        this.onError(`decoder configure failed: ${e.message}`);
        return;
      }
    }

    try {
      this.decoder.decode(
        new window.EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp: timestampUs,
          data: payload,
        })
      );
    } catch (e) {
      // A mid-stream decode error (e.g. we joined before the first keyframe, or a
      // packet was dropped) is expected occasionally on a live/lossy feed — reset
      // and wait for the next keyframe rather than tearing down the connection.
      this._configured = false;
      if (isKeyframe) this.onError(`decode error on keyframe: ${e.message}`);
    }
  }

  _renderFrame(frame) {
    if (this.ctx) {
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0);
    }
    frame.close();
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
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  _cleanupDecoder() {
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch { /* already closed */ }
      this.decoder = null;
    }
    this._configured = false;
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._cleanupSocket();
    this._cleanupDecoder();
  }
}

// Cheap Annex-B NAL-type sniff: scan for a start code, then read the NAL header's
// type field (H.264: low 5 bits of the byte after the start code). Type 5 = IDR slice.
function _looksLikeH264Keyframe(bytes) {
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      let offset = -1;
      if (bytes[i + 2] === 1) offset = i + 3;
      else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) offset = i + 4;
      if (offset === -1 || offset >= bytes.length) continue;
      const nalType = bytes[offset] & 0x1f;
      if (nalType === 5) return true;
      if (nalType === 1) return false;
    }
  }
  return false;
}

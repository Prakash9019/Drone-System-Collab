#!/bin/bash
# Start a local RTSP test stream for GCS video testing.
# Requires: mediamtx (brew install mediamtx), ffmpeg (brew install ffmpeg)
#
# Stream URL: rtsp://localhost:8554/test
# Set this in the GCS Video page → RTSP URL field.

set -e

MEDIAMTX_CFG=/tmp/mediamtx_gcs.yml
MEDIAMTX_LOG=/tmp/mediamtx_gcs.log
FFMPEG_LOG=/tmp/ffmpeg_rtsp.log

cleanup() {
  echo ""
  echo "Stopping test stream..."
  kill "$FFMPEG_PID" 2>/dev/null || true
  kill "$MEDIAMTX_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# Write mediamtx config
cat > "$MEDIAMTX_CFG" << 'EOF'
paths:
  all_others:
EOF

# Start mediamtx
echo "Starting mediamtx RTSP server on :8554..."
mediamtx "$MEDIAMTX_CFG" &>"$MEDIAMTX_LOG" &
MEDIAMTX_PID=$!
sleep 1

# Check it started
if ! nc -zv localhost 8554 2>/dev/null; then
  echo "ERROR: mediamtx failed to start. Check $MEDIAMTX_LOG"
  exit 1
fi
echo "mediamtx running (PID $MEDIAMTX_PID)"

# Push H264 test pattern via ffmpeg
echo "Starting ffmpeg H264 test stream → rtsp://localhost:8554/test"
ffmpeg -re \
  -f lavfi -i "testsrc2=size=1280x720:rate=25" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p -g 25 -b:v 800k \
  -rtsp_transport tcp \
  -f rtsp rtsp://localhost:8554/test \
  -loglevel warning &>"$FFMPEG_LOG" &
FFMPEG_PID=$!
sleep 2

# Verify stream is live
if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
  echo "ERROR: ffmpeg failed. Check $FFMPEG_LOG"
  cat "$FFMPEG_LOG"
  exit 1
fi

echo ""
echo "Test stream is live!"
echo "  RTSP URL: rtsp://localhost:8554/test"
echo "  Set this in GCS Video page, then click Start."
echo ""
echo "Press Ctrl+C to stop."

wait "$FFMPEG_PID"

import gi

gi.require_version('Gst', '1.0')
gi.require_version('GstRtspServer', '1.0')
from gi.repository import GLib, Gst, GstRtspServer

Gst.init(None)

server = GstRtspServer.RTSPServer()
server.props.service = "8554"

factory = GstRtspServer.RTSPMediaFactory()
factory.set_launch(
    '( videotestsrc is-live=1 pattern=smpte ! '
    'video/x-raw,width=1280,height=720,framerate=30/1 ! '
    'x264enc tune=zerolatency speed-preset=ultrafast bitrate=1000 ! '
    'rtph264pay name=pay0 pt=96 config-interval=1 )'
)
factory.set_shared(True)

mounts = server.get_mount_points()
mounts.add_factory("/test", factory)

server.attach(None)
print("RTSP stream ready at rtsp://127.0.0.1:8554/test")

loop = GLib.MainLoop()
loop.run()
import React, { useEffect, useRef } from 'react';

const SEVERITY_LABELS = {
  0: 'EMERGENCY', 1: 'ALERT', 2: 'CRITICAL', 3: 'ERROR',
  4: 'WARNING',   5: 'NOTICE', 6: 'INFO',    7: 'DEBUG'
};

const SEVERITY_COLORS = {
  0: '#ff0000', 1: '#ff2200', 2: '#ff4400', 3: '#ef4444',
  4: '#f59e0b', 5: '#a3e635', 6: '#94a3b8', 7: '#6b7280'
};

const MessagesTab = ({ vehicleState }) => {
  const consoleRef = useRef(null);
  const bottomRef = useRef(null);
  const messages = vehicleState?.status_messages || [];

  // Auto-scroll only if user is already near the bottom.
  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages.length]);

  return (
    <div className="messages-tab">
      {messages.length === 0 ? (
        <div className="tab-empty">No messages received yet.</div>
      ) : (
        <div className="messages-console" ref={consoleRef}>
          {messages.map((msg, i) => {
            const ts = msg.timestamp
              ? new Date(msg.timestamp * 1000).toLocaleTimeString()
              : '--:--:--';
            const severityLabel = SEVERITY_LABELS[msg.severity] || 'INFO';
            const color = SEVERITY_COLORS[msg.severity] || '#94a3b8';
            const rowKey = `${msg.timestamp || i}-${msg.severity || 0}-${String(msg.text || '')}`;
            return (
              <div key={rowKey} className="message-row">
                <span className="msg-ts">{ts}</span>
                <span className="msg-severity" style={{ color }}>[{severityLabel}]</span>
                <span className="msg-text">{msg.text}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};

export default MessagesTab;

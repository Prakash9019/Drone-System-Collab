"""Persistence-side services: flight detection, telemetry sampling, retention.

These run alongside — never inside — the real-time telemetry publish loop. A
stall or exception here is counted and survived; it must never back-pressure
telemetry delivery to live viewers (Phase 5B doc §8, master §9.2).
"""

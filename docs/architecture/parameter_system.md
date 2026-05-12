# Parameter System Architecture

## Goals

- Mission Planner-like reliability for 2k-4k parameters.
- Correct MAVLink param protocol handling.
- Incremental frontend sync and robust recovery.

## Components

- `python_service/parameter_manager.py`
  - canonical cache (`parameters`, `param_types`)
  - sync accounting (`reported`, `received_indexes`, `missing`)
  - state machine (`IDLE`, `SYNCING`, `RECOVERING_MISSING`, `COMPLETE`, `PARTIAL`)
- `python_service/mavlink_link.py`
  - feeds `PARAM_VALUE` packets to manager.
- `python_service/main.py`
  - `/parameters/refresh` triggers full sync flow.
  - `/parameters/status` exposes sync state.
- `python_service/telemetry_pub.py`
  - publishes `PARAM_SYNC_STATUS`.
- `frontend/src/pages/Params.jsx`
  - category/search/sort + dirty tracking + sync progress.

## MAVLink Flow

1. Send `PARAM_REQUEST_LIST`.
2. Accept stream of `PARAM_VALUE` and index/count metadata.
3. On timeout/incomplete list:
   - send batched `PARAM_REQUEST_READ` for missing indexes.
4. Mark completion when `received == reported`.

## Reliability

- Missing recovery in batches (10/index window).
- Sync progress continuously visible in UI.
- Partial completion state surfaced to operator.

## Next Steps

- ACK-validated `PARAM_SET` with expected echo verification.
- Persistent cache to disk with staleness policy.
- metadata/range/enum/reboot-required model for safe tuning UI.

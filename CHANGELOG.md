# Changelog

## 0.2.3 (2026-08-30)

- Fixed GitHub installations failing with `cannot find start file` by tracking the compiled `build/` output in the repository.
- Removed `showFirstAddOnTop` from JSON Config for compatibility with ioBroker Admin 8.0.1.
- Improved automatic server ID generation in the Admin table.
- Runtime fallback now uses `server1`, `server2`, ... when an older Admin version does not persist the generated ID.
- Added repository metadata and maintainer name.

## 0.2.2 (2026-08-30)

- Removed the copy-to-clipboard buttons from the technical server ID column.
- Technical server IDs remain automatic and read-only.
- Server display names remain freely editable.

## 0.2.1 (2026-08-30)

- Technical server IDs are generated automatically (`server1`, `server2`, ...).
- Server IDs are read-only in the Admin UI.
- Server display names are generated sequentially and remain editable.
- Removed the clone button to avoid accidental duplicate IDs/credentials.


## 0.2.0 (2026-08-30)

- Added support for multiple Xtream servers in one adapter instance.
- Added configurable server table in Admin.
- Added per-server object tree below `servers.<id>`.
- Added `offlineSince` per server.
- Added summary states (`onlineCount`, `offlineCount`, `allOnline`).
- Added encrypted/protected credentials in server arrays for js-controller >= 7.0.7.
- Kept optional status-change-only logging without repetitive offline log spam.

## 0.1.0 (2026-08-30)

- Initial development version.
- Monitors one Xtream-compatible account via `player_api.php`.

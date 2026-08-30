# ioBroker.xtream-monitor

Monitors availability and account metadata of user-configured Xtream-compatible API endpoints.

The adapter is a monitoring tool only. It does **not** provide, discover, proxy, play, or distribute media streams. Users are responsible for the endpoints and services they configure.

## Features

- Monitor multiple endpoints in one adapter instance
- Online/offline and account status
- Response time
- Active and maximum connection counts
- Expiration date and days remaining
- Last check, last online and offline-since timestamps
- Error classification for timeout, DNS, HTTP, invalid response and inactive accounts
- Optional logging only when the online/offline state actually changes
- Summary states for VIS, Grafana and other ioBroker visualizations

## Requirements

- Node.js 22 or newer
- js-controller 7.0.7 or newer
- Admin 7.6.20 or newer

## Configuration

Add one or more endpoints in the adapter settings. Each row contains:

- **Enabled** - include the endpoint in monitoring
- **Name** - a user-friendly label
- **Host / Server URL** - base URL of the Xtream-compatible endpoint
- **Username** - account name
- **Password** - account password; the table configuration requests encrypted storage for this column

You can also configure the polling interval, request timeout and optional status-change logging.

Technical server IDs (`server1`, `server2`, ...) are managed internally and are not shown in the Admin UI.

## Object structure

```text
xtream-monitor.0
├── info
│   ├── connection
│   ├── allOnline
│   ├── enabledCount
│   ├── onlineCount
│   ├── offlineCount
│   └── lastCheck
└── servers
    ├── server1
    │   ├── online
    │   ├── status
    │   ├── responseMs
    │   ├── activeConnections
    │   ├── maxConnections
    │   ├── expiration
    │   ├── expirationText
    │   ├── daysRemaining
    │   ├── lastCheck
    │   ├── lastOnline
    │   ├── offlineSince
    │   └── errorType
    └── ...
```

## Privacy and security

- The adapter contacts only endpoints explicitly configured by the user.
- Credentials are never intentionally written to the ioBroker log.
- Password columns are configured for encrypted storage in the Admin table.
- No media content is fetched for monitoring; the adapter queries account/status metadata via the compatible API endpoint.

## Development

```bash
npm install
npm run build
npm run check
npm run lint
npm run test:package
npm run test:integration
```

Repository checks can be run with:

```bash
npx @iobroker/repochecker https://github.com/chrvidal/ioBroker.xtream-monitor main
```

## Changelog

### 0.2.6 (2026-08-30)

- Prepared repository metadata for ioBroker public repository review.
- Added all required metadata translations and Admin translations.
- Added a responsive Admin layout and table-level password encryption configuration.
- Added package and integration test scaffolding plus GitHub Actions CI.
- Replaced unmanaged JavaScript timers with ioBroker adapter-managed timers.
- Added adapter icon, Dependabot configuration and editor JSON schemas.

### 0.2.5 (2026-08-30)

- Removed the technical server ID column from the Admin UI while keeping persistent internal IDs.

### 0.2.4 (2026-08-30)

- Improved persistent internal server-ID assignment and Admin compatibility.

### 0.2.3 (2026-08-30)

- Fixed GitHub installation by including the compiled adapter entry point.

### 0.2.2 (2026-08-30)

- Simplified server-ID handling in the Admin UI.

### 0.2.1 (2026-08-30)

- Added automatic technical server IDs.

### 0.2.0 (2026-08-30)

- Added monitoring of multiple endpoints in one adapter instance.

## License

MIT License. See [LICENSE](LICENSE).

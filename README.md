# ioBroker.xtream-monitor

Development adapter for monitoring Xtream-compatible API endpoints.

## Features

- Multiple servers per adapter instance
- Account online/status
- Response time
- Active/max connections
- Expiration date and days remaining
- Last check / last online / offline since
- Error classification (timeout, DNS, HTTP, invalid response, inactive)
- Optional logging only on real online/offline transitions
- Summary states for Grafana / VIS

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

## Security

Server passwords are configured as `servers.password` in `encryptedNative` and user names/passwords are protected via `protectedNative`. Complex encrypted/protected native paths require js-controller >= 7.0.7.

## Development

```bash
npm install
npm run build
dev-server setup --adminPort 8085
dev-server watch default
```

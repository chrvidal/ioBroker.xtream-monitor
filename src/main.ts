import * as utils from "@iobroker/adapter-core";

interface XtreamUserInfo {
    auth?: number | string;
    status?: string;
    exp_date?: string | number | null;
    active_cons?: string | number;
    max_connections?: string | number;
}

interface XtreamResponse {
    user_info?: XtreamUserInfo;
}

interface ServerConfig {
    enabled: boolean;
    id: string;
    name: string;
    host: string;
    username: string;
    password: string;
}

interface CheckResult {
    id: string;
    online: boolean;
}

type ErrorType =
    | "none"
    | "timeout"
    | "dns"
    | "http"
    | "invalid_json"
    | "invalid_response"
    | "inactive"
    | "request";

class XtreamMonitor extends utils.Adapter {
    private pollTimer?: ioBroker.Interval;
    private readonly lastOnlineStates = new Map<string, boolean>();
    private servers: ServerConfig[] = [];

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "xtream-monitor",
        });

        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.ensurePersistentServerIds();
        this.servers = this.getConfiguredServers();

        await this.createInfoObjects();
        await this.removeLegacyObjects();

        if (this.servers.length === 0) {
            await this.setSummary([]);
            this.log.warn("No enabled Xtream servers configured.");
            return;
        }

        for (const server of this.servers) {
            await this.createServerObjects(server);
        }

        await this.checkAllServers();

        const intervalMinutes = Math.max(1, Number(this.config.pollIntervalMinutes) || 5);
        this.pollTimer = this.setInterval(() => {
            void this.checkAllServers();
        }, intervalMinutes * 60_000);
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
                this.pollTimer = undefined;
            }
            callback();
        } catch {
            callback();
        }
    }

    private async ensurePersistentServerIds(): Promise<void> {
        const objectId = `system.adapter.${this.namespace}`;
        const instanceObject = await this.getForeignObjectAsync(objectId);

        if (!instanceObject?.native || !Array.isArray(instanceObject.native.servers)) {
            return;
        }

        const rows = instanceObject.native.servers as Array<Record<string, unknown>>;
        const usedIds = new Set<string>();
        let nextServerId = Number(instanceObject.native.nextServerId) || 1;

        // Never reuse an ID that already exists, even if nextServerId is stale.
        for (const row of rows) {
            const existingId = this.sanitizeId(String(row.id ?? ""));
            const match = /^server(\d+)$/.exec(existingId);
            if (match) {
                nextServerId = Math.max(nextServerId, Number(match[1]) + 1);
            }
        }

        let changed = false;

        for (const row of rows) {
            let id = this.sanitizeId(String(row.id ?? ""));

            if (!id || usedIds.has(id)) {
                do {
                    id = `server${nextServerId++}`;
                } while (usedIds.has(id));

                row.id = id;
                changed = true;
            }

            usedIds.add(id);
        }

        if (Number(instanceObject.native.nextServerId) !== nextServerId) {
            instanceObject.native.nextServerId = nextServerId;
            changed = true;
        }

        if (!changed) {
            return;
        }

        await this.setForeignObjectAsync(objectId, instanceObject);

        // Keep the in-memory config in sync for the current run. Password values in the
        // stored instance object remain untouched (and therefore stay encrypted).
        if (Array.isArray(this.config.servers)) {
            this.config.servers.forEach((row, index) => {
                if (rows[index]?.id) {
                    row.id = String(rows[index].id);
                }
            });
        }

        this.log.info("Assigned persistent IDs to server rows with missing or duplicate IDs.");
    }

    private getConfiguredServers(): ServerConfig[] {
        const configured = Array.isArray(this.config.servers) ? this.config.servers : [];
        const source = configured.length > 0
            ? configured
            : this.getLegacyServerConfig();

        const usedIds = new Set<string>();
        const result: ServerConfig[] = [];

        source.forEach((raw, index) => {
            if (raw.enabled === false) {
                return;
            }

            const host = String(raw.host ?? "").trim();
            const username = String(raw.username ?? "").trim();
            const password = String(raw.password ?? "");

            if (!host || !username || !password) {
                this.log.warn(`Skipping server row ${index + 1}: host, username or password is missing.`);
                return;
            }

            let id = this.sanitizeId(String(raw.id || `server${index + 1}`));
            if (!id) {
                id = `server${index + 1}`;
            }

            if (usedIds.has(id)) {
                let suffix = 2;
                while (usedIds.has(`${id}_${suffix}`)) {
                    suffix++;
                }
                const oldId = id;
                id = `${id}_${suffix}`;
                this.log.warn(`Duplicate server ID "${oldId}" detected. Runtime ID changed to "${id}".`);
            }
            usedIds.add(id);

            result.push({
                enabled: true,
                id,
                name: String(raw.name || raw.id || `Server ${index + 1}`).trim(),
                host,
                username,
                password,
            });
        });

        return result;
    }

    private getLegacyServerConfig(): ioBroker.XtreamMonitorServerConfig[] {
        if (!this.config.host || !this.config.username || !this.config.password) {
            return [];
        }

        this.log.info("Using legacy 0.1.x single-server configuration. Add the server to the new table when convenient.");
        return [{
            enabled: true,
            id: "server1",
            name: "Server 1",
            host: this.config.host,
            username: this.config.username,
            password: this.config.password,
        }];
    }

    private sanitizeId(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "_")
            .replace(/^[_-]+|[_-]+$/g, "")
            .slice(0, 64);
    }

    private async removeLegacyObjects(): Promise<void> {
        const legacy = await this.getObjectAsync("account");
        if (legacy) {
            await this.delObjectAsync("account", { recursive: true });
        }
    }

    private async createInfoObjects(): Promise<void> {
        await this.extendObjectAsync("servers", {
            type: "channel",
            common: { name: "Servers" },
            native: {},
        });

        await this.extendObjectAsync("info.connection", {
            type: "state",
            common: {
                name: "Any server online",
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        await this.extendObjectAsync("info.allOnline", {
            type: "state",
            common: {
                name: "All servers online",
                type: "boolean",
                role: "indicator",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        await this.extendObjectAsync("info.enabledCount", {
            type: "state",
            common: {
                name: "Enabled servers",
                type: "number",
                role: "value",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.extendObjectAsync("info.onlineCount", {
            type: "state",
            common: {
                name: "Online servers",
                type: "number",
                role: "value",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.extendObjectAsync("info.offlineCount", {
            type: "state",
            common: {
                name: "Offline servers",
                type: "number",
                role: "value",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.extendObjectAsync("info.lastCheck", {
            type: "state",
            common: {
                name: "Last complete check",
                type: "number",
                role: "date",
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
    }

    private async createServerObjects(server: ServerConfig): Promise<void> {
        const base = `servers.${server.id}`;

        await this.extendObjectAsync(base, {
            type: "channel",
            common: { name: server.name },
            native: {},
        });

        const states: Array<{
            id: string;
            name: string;
            type: ioBroker.CommonType;
            role: string;
            def: string | number | boolean;
            unit?: string;
        }> = [
            { id: "online", name: "Account online", type: "boolean", role: "indicator.connected", def: false },
            { id: "status", name: "Account status", type: "string", role: "text", def: "unknown" },
            { id: "responseMs", name: "Response time", type: "number", role: "value.interval", def: 0, unit: "ms" },
            { id: "activeConnections", name: "Active connections", type: "number", role: "value", def: 0 },
            { id: "maxConnections", name: "Maximum connections", type: "number", role: "value", def: 0 },
            { id: "expiration", name: "Expiration timestamp", type: "number", role: "date", def: 0 },
            { id: "expirationText", name: "Expiration date", type: "string", role: "text", def: "unknown" },
            { id: "daysRemaining", name: "Days remaining", type: "number", role: "value.interval", def: 0, unit: "d" },
            { id: "lastCheck", name: "Last check", type: "number", role: "date", def: 0 },
            { id: "lastOnline", name: "Last online", type: "number", role: "date", def: 0 },
            { id: "offlineSince", name: "Offline since", type: "number", role: "date", def: 0 },
            { id: "errorType", name: "Error type", type: "string", role: "text", def: "none" },
        ];

        for (const state of states) {
            await this.extendObjectAsync(`${base}.${state.id}`, {
                type: "state",
                common: {
                    name: state.name,
                    type: state.type,
                    role: state.role,
                    read: true,
                    write: false,
                    def: state.def,
                    ...(state.unit ? { unit: state.unit } : {}),
                },
                native: {},
            });
        }
    }

    private normalizeHost(host: string): string {
        const trimmed = host.trim().replace(/\/+$/, "");
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
        return `http://${trimmed}`;
    }

    private buildApiUrl(server: ServerConfig): string {
        const host = this.normalizeHost(server.host);
        const url = new URL(`${host}/player_api.php`);
        url.searchParams.set("username", server.username);
        url.searchParams.set("password", server.password);
        return url.toString();
    }

    private async checkAllServers(): Promise<void> {
        const results = await Promise.all(this.servers.map(server => this.checkServer(server)));
        await this.setSummary(results);
    }

    private async setSummary(results: CheckResult[]): Promise<void> {
        const enabledCount = this.servers.length;
        const onlineCount = results.filter(result => result.online).length;
        const offlineCount = Math.max(0, enabledCount - onlineCount);
        const anyOnline = onlineCount > 0;
        const allOnline = enabledCount > 0 && onlineCount === enabledCount;

        await Promise.all([
            this.setStateAsync("info.connection", { val: anyOnline, ack: true }),
            this.setStateAsync("info.allOnline", { val: allOnline, ack: true }),
            this.setStateAsync("info.enabledCount", { val: enabledCount, ack: true }),
            this.setStateAsync("info.onlineCount", { val: onlineCount, ack: true }),
            this.setStateAsync("info.offlineCount", { val: offlineCount, ack: true }),
            this.setStateAsync("info.lastCheck", { val: Date.now(), ack: true }),
        ]);
    }

    private async checkServer(server: ServerConfig): Promise<CheckResult> {
        const base = `servers.${server.id}`;
        const started = Date.now();
        const now = Date.now();
        const timeoutMs = Math.max(1, Number(this.config.timeoutSeconds) || 10) * 1000;
        const controller = new AbortController();
        const timeout = this.setTimeout(() => controller.abort(), timeoutMs);

        await this.setStateAsync(`${base}.lastCheck`, { val: now, ack: true });

        try {
            const response = await fetch(this.buildApiUrl(server), {
                method: "GET",
                headers: {
                    "User-Agent": "ioBroker.xtream-monitor",
                    Accept: "application/json,text/plain,*/*",
                },
                signal: controller.signal,
                redirect: "follow",
            });

            const responseMs = Date.now() - started;
            await this.setStateAsync(`${base}.responseMs`, { val: responseMs, ack: true });

            if (!response.ok) {
                return this.setOffline(server, "http", `HTTP ${response.status}`);
            }

            let data: XtreamResponse;
            try {
                data = (await response.json()) as XtreamResponse;
            } catch {
                return this.setOffline(server, "invalid_json", "Invalid JSON response");
            }

            if (!data.user_info) {
                return this.setOffline(server, "invalid_response", "user_info missing");
            }

            const user = data.user_info;
            const authenticated = String(user.auth ?? "0") === "1";
            const status = String(user.status ?? "unknown");
            const isActive = authenticated && status.toLowerCase() === "active";

            const activeConnections = Number.parseInt(String(user.active_cons ?? 0), 10) || 0;
            const maxConnections = Number.parseInt(String(user.max_connections ?? 0), 10) || 0;
            const expirationSeconds = Number.parseInt(String(user.exp_date ?? 0), 10) || 0;
            const expirationMs = expirationSeconds > 0 ? expirationSeconds * 1000 : 0;
            const daysRemaining = expirationMs > 0
                ? Math.max(0, Math.ceil((expirationMs - Date.now()) / 86_400_000))
                : 0;
            const expirationText = expirationMs > 0
                ? new Date(expirationMs).toLocaleString("de-DE")
                : "unknown";

            await Promise.all([
                this.setStateAsync(`${base}.status`, { val: status, ack: true }),
                this.setStateAsync(`${base}.activeConnections`, { val: activeConnections, ack: true }),
                this.setStateAsync(`${base}.maxConnections`, { val: maxConnections, ack: true }),
                this.setStateAsync(`${base}.expiration`, { val: expirationMs, ack: true }),
                this.setStateAsync(`${base}.expirationText`, { val: expirationText, ack: true }),
                this.setStateAsync(`${base}.daysRemaining`, { val: daysRemaining, ack: true }),
            ]);

            if (!isActive) {
                return this.setOffline(server, "inactive", status);
            }

            return this.setOnline(server, status);
        } catch (error) {
            const err = error as Error & { cause?: { code?: string } };
            const code = err.cause?.code;

            if (err.name === "AbortError") {
                return this.setOffline(server, "timeout", "Request timed out");
            }
            if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
                return this.setOffline(server, "dns", code);
            }
            return this.setOffline(server, "request", err.message || "Request failed");
        } finally {
            this.clearTimeout(timeout);
        }
    }

    private async setOnline(server: ServerConfig, status: string): Promise<CheckResult> {
        const base = `servers.${server.id}`;
        const now = Date.now();

        await Promise.all([
            this.setStateAsync(`${base}.online`, { val: true, ack: true }),
            this.setStateAsync(`${base}.status`, { val: status, ack: true }),
            this.setStateAsync(`${base}.errorType`, { val: "none", ack: true }),
            this.setStateAsync(`${base}.lastOnline`, { val: now, ack: true }),
            this.setStateAsync(`${base}.offlineSince`, { val: 0, ack: true }),
        ]);

        this.logTransition(server, true);
        return { id: server.id, online: true };
    }

    private async setOffline(server: ServerConfig, errorType: ErrorType, status: string): Promise<CheckResult> {
        const base = `servers.${server.id}`;
        const previousOnline = this.lastOnlineStates.get(server.id);

        await Promise.all([
            this.setStateAsync(`${base}.online`, { val: false, ack: true }),
            this.setStateAsync(`${base}.status`, { val: status, ack: true }),
            this.setStateAsync(`${base}.errorType`, { val: errorType, ack: true }),
        ]);

        if (previousOnline !== false) {
            await this.setStateAsync(`${base}.offlineSince`, { val: Date.now(), ack: true });
        }

        this.logTransition(server, false);
        return { id: server.id, online: false };
    }

    private logTransition(server: ServerConfig, online: boolean): void {
        const previous = this.lastOnlineStates.get(server.id);
        this.lastOnlineStates.set(server.id, online);

        if (previous === undefined || previous === online || !this.config.logStatusChanges) {
            return;
        }

        if (online) {
            this.log.info(`${server.name} (${server.id}) is online again.`);
        } else {
            this.log.info(`${server.name} (${server.id}) went offline.`);
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new XtreamMonitor(options);
} else {
    (() => new XtreamMonitor())();
}

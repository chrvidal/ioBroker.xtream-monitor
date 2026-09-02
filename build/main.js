"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
class XtreamMonitor extends utils.Adapter {
    pollTimer;
    lastOnlineStates = new Map();
    offlineSinceStates = new Map();
    activeControllers = new Set();
    servers = [];
    stopping = false;
    systemSecret = '';
    constructor(options = {}) {
        super({
            ...options,
            name: 'xtream-monitor',
        });
        this.on('ready', () => {
            void this.onReady().catch(error => {
                if (this.stopping) {
                    return;
                }
                const message = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
                this.log.error(`Startup failed: ${message}`);
            });
        });
        this.on('unload', this.onUnload.bind(this));
    }
    async onReady() {
        this.stopping = false;
        await this.loadSystemSecret();
        if (await this.ensurePersistentServerIds()) {
            this.log.info('Persistent server IDs were stored. Waiting for ioBroker to restart the instance.');
            return;
        }
        this.servers = this.getConfiguredServers();
        await this.removeStaleServerObjects();
        await this.createInfoObjects();
        await this.removeLegacyObjects();
        if (this.servers.length === 0) {
            await this.setSummary([]);
            this.log.warn('No enabled Xtream servers configured.');
            return;
        }
        for (const server of this.servers) {
            await this.createServerObjects(server);
        }
        await this.restoreRuntimeStates();
        await this.runCheckCycle();
    }
    onUnload(callback) {
        this.stopping = true;
        try {
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
            for (const controller of this.activeControllers) {
                controller.abort();
            }
            this.activeControllers.clear();
        }
        finally {
            callback();
        }
    }
    async ensurePersistentServerIds() {
        const objectId = `system.adapter.${this.namespace}`;
        const instanceObject = await this.getForeignObjectAsync(objectId);
        if (!instanceObject?.native || !Array.isArray(instanceObject.native.servers)) {
            return false;
        }
        const rows = instanceObject.native.servers;
        const usedIds = new Set();
        let nextServerId = Number(instanceObject.native.nextServerId) || 1;
        // Never reuse an ID that already exists, even if nextServerId is stale.
        for (const row of rows) {
            const existingId = this.sanitizeId(typeof row.id === 'string' ? row.id : '');
            const match = /^server(\d+)$/.exec(existingId);
            if (match) {
                nextServerId = Math.max(nextServerId, Number(match[1]) + 1);
            }
        }
        let changed = false;
        for (const row of rows) {
            let id = this.sanitizeId(typeof row.id === 'string' ? row.id : '');
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
            return false;
        }
        await this.setForeignObjectAsync(objectId, instanceObject);
        // Keep the in-memory config in sync for the current run. Password values in the
        // stored instance object remain untouched and therefore stay encrypted by Admin.
        if (Array.isArray(this.config.servers)) {
            this.config.servers.forEach((row, index) => {
                const persistedId = rows[index]?.id;
                if (typeof persistedId === 'string') {
                    row.id = persistedId;
                }
            });
        }
        this.log.info('Assigned persistent IDs to server rows with missing or duplicate IDs.');
        return true;
    }
    getConfiguredServers() {
        const configured = Array.isArray(this.config.servers) ? this.config.servers : [];
        const source = configured.length > 0 ? configured : this.getLegacyServerConfig();
        const usedIds = new Set();
        const result = [];
        source.forEach((raw, index) => {
            if (raw.enabled === false) {
                return;
            }
            const host = String(raw.host ?? '').trim();
            const username = String(raw.username ?? '').trim();
            const password = String(raw.password ?? '');
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
    getLegacyServerConfig() {
        if (!this.config.host || !this.config.username || !this.config.password) {
            return [];
        }
        this.log.info('Using legacy 0.1.x single-server configuration. Add the server to the new table when convenient.');
        return [
            {
                enabled: true,
                id: 'server1',
                name: 'Server 1',
                host: this.config.host,
                username: this.config.username,
                password: this.config.password,
            },
        ];
    }
    sanitizeId(value) {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^[_-]+|[_-]+$/g, '')
            .slice(0, 64);
    }
    async removeStaleServerObjects() {
        const keepIds = new Set(this.servers.map(server => server.id));
        const configuredRows = Array.isArray(this.config.servers) ? this.config.servers : [];
        for (const row of configuredRows) {
            const id = this.sanitizeId(String(row.id ?? ''));
            if (id) {
                keepIds.add(id);
            }
        }
        const objects = await this.getAdapterObjectsAsync();
        const prefix = `${this.namespace}.servers.`;
        const staleIds = new Set();
        for (const objectId of Object.keys(objects)) {
            if (!objectId.startsWith(prefix)) {
                continue;
            }
            const relative = objectId.slice(prefix.length);
            const serverId = relative.split('.')[0];
            if (serverId && !keepIds.has(serverId)) {
                staleIds.add(serverId);
            }
        }
        for (const serverId of staleIds) {
            this.log.info(`Removing objects for deleted server "${serverId}".`);
            await this.delObjectAsync(`servers.${serverId}`, {
                recursive: true,
            });
            this.lastOnlineStates.delete(serverId);
            this.offlineSinceStates.delete(serverId);
        }
    }
    async removeLegacyObjects() {
        const legacy = await this.getObjectAsync('account');
        if (legacy) {
            await this.delObjectAsync('account', { recursive: true });
        }
    }
    async createInfoObjects() {
        await this.extendObjectAsync('info', {
            type: 'channel',
            common: { name: 'Information' },
            native: {},
        });
        await this.extendObjectAsync('servers', {
            type: 'channel',
            common: { name: 'Servers' },
            native: {},
        });
        await this.extendObjectAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Any server online',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.extendObjectAsync('info.allOnline', {
            type: 'state',
            common: {
                name: 'All servers online',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.extendObjectAsync('info.enabledCount', {
            type: 'state',
            common: {
                name: 'Enabled servers',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.extendObjectAsync('info.onlineCount', {
            type: 'state',
            common: {
                name: 'Online servers',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.extendObjectAsync('info.offlineCount', {
            type: 'state',
            common: {
                name: 'Offline servers',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.extendObjectAsync('info.lastCheck', {
            type: 'state',
            common: {
                name: 'Last complete check',
                type: 'number',
                role: 'date',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
    }
    async createServerObjects(server) {
        const base = `servers.${server.id}`;
        await this.extendObjectAsync(base, {
            type: 'channel',
            common: { name: server.name },
            native: {},
        });
        const states = [
            { id: 'online', name: 'Account online', type: 'boolean', role: 'indicator.reachable', def: false },
            { id: 'status', name: 'Account status', type: 'string', role: 'text', def: 'unknown' },
            { id: 'responseMs', name: 'Response time', type: 'number', role: 'time.span', def: 0, unit: 'ms' },
            { id: 'activeConnections', name: 'Active connections', type: 'number', role: 'value', def: 0 },
            { id: 'maxConnections', name: 'Maximum connections', type: 'number', role: 'value', def: 0 },
            { id: 'expiration', name: 'Expiration timestamp', type: 'number', role: 'date', def: 0 },
            { id: 'expirationText', name: 'Expiration date', type: 'string', role: 'text', def: 'unknown' },
            { id: 'daysRemaining', name: 'Days remaining', type: 'number', role: 'value', def: 0, unit: 'd' },
            { id: 'lastCheck', name: 'Last check', type: 'number', role: 'date', def: 0 },
            { id: 'lastOnline', name: 'Last online', type: 'number', role: 'date', def: 0 },
            { id: 'offlineSince', name: 'Offline since', type: 'number', role: 'date', def: 0 },
            { id: 'errorType', name: 'Error type', type: 'string', role: 'text', def: 'none' },
        ];
        for (const state of states) {
            await this.extendObjectAsync(`${base}.${state.id}`, {
                type: 'state',
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
    async restoreRuntimeStates() {
        for (const server of this.servers) {
            const base = `servers.${server.id}`;
            const [onlineState, offlineSinceState] = await Promise.all([
                this.getStateAsync(`${base}.online`),
                this.getStateAsync(`${base}.offlineSince`),
            ]);
            if (typeof onlineState?.val === 'boolean') {
                this.lastOnlineStates.set(server.id, onlineState.val);
            }
            if (typeof offlineSinceState?.val === 'number' && offlineSinceState.val > 0) {
                this.offlineSinceStates.set(server.id, offlineSinceState.val);
            }
        }
    }
    async loadSystemSecret() {
        try {
            const systemConfig = await this.getForeignObjectAsync('system.config');
            const secret = systemConfig?.native?.secret;
            if (typeof secret === 'string' && secret.length > 0) {
                this.systemSecret = secret;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.debug(`Could not read ioBroker system secret: ${message}`);
        }
    }
    getPasswordFallback(password) {
        if (!password || !this.systemSecret) {
            return undefined;
        }
        // ioBroker json-config currently has a regression for encrypted
        // attributes inside tables. With legacy encryption a saved password
        // can therefore alternate between plaintext and XOR-encrypted text.
        // XOR is reversible, so this gives us the other possible form.
        let result = '';
        for (let i = 0; i < password.length; i++) {
            result += String.fromCharCode(this.systemSecret[i % this.systemSecret.length].charCodeAt(0) ^ password.charCodeAt(i));
        }
        return result !== password ? result : undefined;
    }
    normalizeHost(host) {
        const trimmed = host.trim().replace(/\/+$/, '');
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
        return `http://${trimmed}`;
    }
    buildApiUrl(server) {
        const host = this.normalizeHost(server.host);
        const url = new URL(`${host}/player_api.php`);
        url.searchParams.set('username', server.username);
        url.searchParams.set('password', server.password);
        return url.toString();
    }
    async runCheckCycle() {
        if (this.stopping) {
            return;
        }
        try {
            await this.checkAllServers();
        }
        catch (error) {
            if (!this.stopping) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.error(`Unexpected error while checking configured servers: ${message}`);
            }
        }
        finally {
            if (!this.stopping) {
                this.scheduleNextCheck();
            }
        }
    }
    scheduleNextCheck() {
        if (this.stopping || this.servers.length === 0) {
            return;
        }
        const intervalMinutes = Math.max(1, Number(this.config.pollIntervalMinutes) || 5);
        this.pollTimer = this.setTimeout(() => {
            this.pollTimer = undefined;
            void this.runCheckCycle();
        }, intervalMinutes * 60_000);
    }
    async checkAllServers() {
        if (this.stopping) {
            return;
        }
        const results = await Promise.all(this.servers.map(server => this.checkServer(server)));
        if (!this.stopping) {
            await this.setSummary(results);
        }
    }
    async setSummary(results) {
        if (this.stopping) {
            return;
        }
        const enabledCount = this.servers.length;
        const onlineCount = results.filter(result => result.online).length;
        const offlineCount = Math.max(0, enabledCount - onlineCount);
        const anyOnline = onlineCount > 0;
        const allOnline = enabledCount > 0 && onlineCount === enabledCount;
        await Promise.all([
            this.setStateAsync('info.connection', { val: anyOnline, ack: true }),
            this.setStateAsync('info.allOnline', { val: allOnline, ack: true }),
            this.setStateAsync('info.enabledCount', { val: enabledCount, ack: true }),
            this.setStateAsync('info.onlineCount', { val: onlineCount, ack: true }),
            this.setStateAsync('info.offlineCount', { val: offlineCount, ack: true }),
            this.setStateAsync('info.lastCheck', { val: Date.now(), ack: true }),
        ]);
    }
    currentResult(server) {
        return {
            id: server.id,
            online: this.lastOnlineStates.get(server.id) === true,
        };
    }
    async checkServer(server, allowPasswordFallback = true) {
        if (this.stopping) {
            return this.currentResult(server);
        }
        const base = `servers.${server.id}`;
        const started = Date.now();
        const timeoutMs = Math.max(1, Number(this.config.timeoutSeconds) || 10) * 1000;
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeout = this.setTimeout(() => controller.abort(), timeoutMs);
        await this.setStateAsync(`${base}.lastCheck`, { val: started, ack: true });
        try {
            const response = await fetch(this.buildApiUrl(server), {
                method: 'GET',
                headers: {
                    'User-Agent': 'ioBroker.xtream-monitor',
                    Accept: 'application/json,text/plain,*/*',
                },
                signal: controller.signal,
                redirect: 'follow',
            });
            if (this.stopping) {
                return this.currentResult(server);
            }
            const responseMs = Date.now() - started;
            await this.setStateAsync(`${base}.responseMs`, { val: responseMs, ack: true });
            if (!response.ok) {
                if (allowPasswordFallback &&
                    (response.status === 401 || response.status === 403 || response.status === 513)) {
                    const fallbackPassword = this.getPasswordFallback(server.password);
                    if (fallbackPassword) {
                        return this.checkServer({ ...server, password: fallbackPassword }, false);
                    }
                }
                return this.setOffline(server, 'http', `HTTP ${response.status}`);
            }
            let data;
            try {
                data = (await response.json());
            }
            catch {
                return this.setOffline(server, 'invalid_json', 'Invalid JSON response');
            }
            if (this.stopping) {
                return this.currentResult(server);
            }
            if (!data.user_info) {
                return this.setOffline(server, 'invalid_response', 'user_info missing');
            }
            const user = data.user_info;
            const authValue = user.auth;
            const authenticated = authValue === true || String(authValue ?? '0') === '1';
            const status = String(user.status ?? 'unknown');
            if (!authenticated && allowPasswordFallback) {
                const fallbackPassword = this.getPasswordFallback(server.password);
                if (fallbackPassword) {
                    return this.checkServer({ ...server, password: fallbackPassword }, false);
                }
            }
            const isActive = authenticated && status.toLowerCase() === 'active';
            const activeConnections = Number.parseInt(String(user.active_cons ?? 0), 10) || 0;
            const maxConnections = Number.parseInt(String(user.max_connections ?? 0), 10) || 0;
            const expirationSeconds = Number.parseInt(String(user.exp_date ?? 0), 10) || 0;
            const expirationMs = expirationSeconds > 0 ? expirationSeconds * 1000 : 0;
            const daysRemaining = expirationMs > 0 ? Math.max(0, Math.ceil((expirationMs - Date.now()) / 86_400_000)) : 0;
            const expirationText = expirationMs > 0 ? new Date(expirationMs).toISOString() : 'unknown';
            await Promise.all([
                this.setStateAsync(`${base}.status`, { val: status, ack: true }),
                this.setStateAsync(`${base}.activeConnections`, { val: activeConnections, ack: true }),
                this.setStateAsync(`${base}.maxConnections`, { val: maxConnections, ack: true }),
                this.setStateAsync(`${base}.expiration`, { val: expirationMs, ack: true }),
                this.setStateAsync(`${base}.expirationText`, { val: expirationText, ack: true }),
                this.setStateAsync(`${base}.daysRemaining`, { val: daysRemaining, ack: true }),
            ]);
            if (!isActive) {
                return this.setOffline(server, 'inactive', status);
            }
            return this.setOnline(server, status);
        }
        catch (error) {
            if (this.stopping) {
                return this.currentResult(server);
            }
            const err = error;
            const code = err.cause?.code;
            if (err.name === 'AbortError') {
                return this.setOffline(server, 'timeout', 'Request timed out');
            }
            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                return this.setOffline(server, 'dns', code);
            }
            return this.setOffline(server, 'request', err.message || 'Request failed');
        }
        finally {
            this.clearTimeout(timeout);
            this.activeControllers.delete(controller);
        }
    }
    async setOnline(server, status) {
        if (this.stopping) {
            return this.currentResult(server);
        }
        const base = `servers.${server.id}`;
        const now = Date.now();
        await Promise.all([
            this.setStateAsync(`${base}.online`, { val: true, ack: true }),
            this.setStateAsync(`${base}.status`, { val: status, ack: true }),
            this.setStateAsync(`${base}.errorType`, { val: 'none', ack: true }),
            this.setStateAsync(`${base}.lastOnline`, { val: now, ack: true }),
            this.setStateAsync(`${base}.offlineSince`, { val: 0, ack: true }),
        ]);
        this.offlineSinceStates.delete(server.id);
        this.logTransition(server, true);
        return { id: server.id, online: true };
    }
    async setOffline(server, errorType, status) {
        if (this.stopping) {
            return this.currentResult(server);
        }
        const base = `servers.${server.id}`;
        const previousOnline = this.lastOnlineStates.get(server.id);
        const existingOfflineSince = this.offlineSinceStates.get(server.id) ?? 0;
        await Promise.all([
            this.setStateAsync(`${base}.online`, { val: false, ack: true }),
            this.setStateAsync(`${base}.status`, { val: status, ack: true }),
            this.setStateAsync(`${base}.errorType`, { val: errorType, ack: true }),
        ]);
        if (previousOnline !== false || existingOfflineSince <= 0) {
            const offlineSince = Date.now();
            await this.setStateAsync(`${base}.offlineSince`, { val: offlineSince, ack: true });
            this.offlineSinceStates.set(server.id, offlineSince);
        }
        this.logTransition(server, false);
        return { id: server.id, online: false };
    }
    logTransition(server, online) {
        const previous = this.lastOnlineStates.get(server.id);
        this.lastOnlineStates.set(server.id, online);
        if (previous === undefined || previous === online || !this.config.logStatusChanges) {
            return;
        }
        if (online) {
            this.log.info(`${server.name} (${server.id}) is online again.`);
        }
        else {
            this.log.info(`${server.name} (${server.id}) went offline.`);
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new XtreamMonitor(options);
}
else {
    (() => new XtreamMonitor())();
}
//# sourceMappingURL=main.js.map
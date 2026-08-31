"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { tests } = require("@iobroker/testing");

const adapterDir = path.join(__dirname, "..");
const adapterName = "xtream-monitor";

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Could not determine mock server address"));
                return;
            }
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function close(server) {
    return new Promise(resolve => {
        if (!server.listening) {
            resolve();
            return;
        }
        if (typeof server.closeIdleConnections === "function") {
            server.closeIdleConnections();
        }
        server.close(() => resolve());
    });
}

function getState(harness, id) {
    return new Promise((resolve, reject) => {
        harness.states.getState(id, (error, state) => {
            if (error) {
                reject(error);
            } else {
                resolve(state);
            }
        });
    });
}

function setState(harness, id, state) {
    return new Promise((resolve, reject) => {
        harness.states.setState(id, state, error => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function getObject(harness, id) {
    return new Promise((resolve, reject) => {
        harness.objects.getObject(id, (error, object) => {
            if (error) {
                reject(error);
            } else {
                resolve(object);
            }
        });
    });
}

function setObject(harness, id, object) {
    return new Promise((resolve, reject) => {
        harness.objects.setObject(id, object, error => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Condition was not met within ${timeoutMs} ms`);
}

tests.integration(adapterDir, {
    defineAdditionalTests({ suite, it }) {
        suite("Xtream-compatible API monitoring", getHarness => {
            let mockServer;
            let baseUrl;

            before(async () => {
                mockServer = http.createServer((request, response) => {
                    const url = new URL(request.url, "http://127.0.0.1");
                    assert.equal(url.pathname, "/player_api.php");
                    assert.equal(url.searchParams.get("password"), "test-secret");

                    const username = url.searchParams.get("username");
                    response.setHeader("Content-Type", "application/json");

                    if (username === "active-user") {
                        const expiration = Math.floor((Date.now() + (30 * 86_400_000)) / 1000);
                        response.end(JSON.stringify({
                            user_info: {
                                auth: 1,
                                status: "Active",
                                exp_date: String(expiration),
                                active_cons: "1",
                                max_connections: "2",
                            },
                        }));
                        return;
                    }

                    response.end(JSON.stringify({
                        user_info: {
                            auth: 1,
                            status: "Expired",
                            exp_date: "0",
                            active_cons: "0",
                            max_connections: "1",
                        },
                    }));
                });
                baseUrl = await listen(mockServer);
            });

            after(async () => {
                await close(mockServer);
            });

            it("writes API data, summaries and ioBroker-compliant object roles", async () => {
                const harness = getHarness();
                await harness.changeAdapterConfig(adapterName, {
                    native: {
                        servers: [
                            {
                                enabled: true,
                                id: "server1",
                                name: "Active test server",
                                host: baseUrl,
                                username: "active-user",
                                password: "test-secret",
                            },
                            {
                                enabled: true,
                                id: "server2",
                                name: "Inactive test server",
                                host: baseUrl,
                                username: "inactive-user",
                                password: "test-secret",
                            },
                        ],
                        pollIntervalMinutes: 60,
                        timeoutSeconds: 5,
                        logStatusChanges: false,
                        nextServerId: 3,
                    },
                });

                await harness.startAdapterAndWait(true);

                const prefix = `${adapterName}.0`;
                const online1 = await getState(harness, `${prefix}.servers.server1.online`);
                const status1 = await getState(harness, `${prefix}.servers.server1.status`);
                const activeCons = await getState(harness, `${prefix}.servers.server1.activeConnections`);
                const maxCons = await getState(harness, `${prefix}.servers.server1.maxConnections`);
                const expirationText = await getState(harness, `${prefix}.servers.server1.expirationText`);
                const daysRemaining = await getState(harness, `${prefix}.servers.server1.daysRemaining`);
                const online2 = await getState(harness, `${prefix}.servers.server2.online`);
                const error2 = await getState(harness, `${prefix}.servers.server2.errorType`);
                const offlineSince2 = await getState(harness, `${prefix}.servers.server2.offlineSince`);
                const onlineCount = await getState(harness, `${prefix}.info.onlineCount`);
                const offlineCount = await getState(harness, `${prefix}.info.offlineCount`);
                const allOnline = await getState(harness, `${prefix}.info.allOnline`);

                assert.equal(online1?.val, true);
                assert.equal(status1?.val, "Active");
                assert.equal(activeCons?.val, 1);
                assert.equal(maxCons?.val, 2);
                assert.match(String(expirationText?.val), /^\d{4}-\d{2}-\d{2}T.*Z$/);
                assert.ok(Number(daysRemaining?.val) >= 29 && Number(daysRemaining?.val) <= 30);

                assert.equal(online2?.val, false);
                assert.equal(error2?.val, "inactive");
                assert.ok(Number(offlineSince2?.val) > 0);

                assert.equal(onlineCount?.val, 1);
                assert.equal(offlineCount?.val, 1);
                assert.equal(allOnline?.val, false);

                const infoObject = await getObject(harness, `${prefix}.info`);
                const onlineObject = await getObject(harness, `${prefix}.servers.server1.online`);
                const responseObject = await getObject(harness, `${prefix}.servers.server1.responseMs`);
                const daysObject = await getObject(harness, `${prefix}.servers.server1.daysRemaining`);

                assert.equal(infoObject?.type, "channel");
                assert.equal(onlineObject?.common?.role, "indicator.reachable");
                assert.equal(responseObject?.common?.role, "time.span");
                assert.equal(responseObject?.common?.unit, "ms");
                assert.equal(daysObject?.common?.role, "value");
                assert.equal(daysObject?.common?.unit, "d");
            });
        });

        suite("Offline timestamp persistence", getHarness => {
            let mockServer;
            let baseUrl;

            before(async () => {
                mockServer = http.createServer((_request, response) => {
                    response.setHeader("Content-Type", "application/json");
                    response.end(JSON.stringify({
                        user_info: {
                            auth: 1,
                            status: "Expired",
                            exp_date: "0",
                            active_cons: "0",
                            max_connections: "1",
                        },
                    }));
                });
                baseUrl = await listen(mockServer);
            });

            after(async () => {
                await close(mockServer);
            });

            it("does not reset offlineSince when a server is still offline after restart", async () => {
                const harness = getHarness();
                const prefix = `${adapterName}.0`;
                const originalOfflineSince = Date.now() - 3_600_000;

                await harness.changeAdapterConfig(adapterName, {
                    native: {
                        servers: [{
                            enabled: true,
                            id: "server1",
                            name: "Persistent offline server",
                            host: baseUrl,
                            username: "inactive-user",
                            password: "test-secret",
                        }],
                        pollIntervalMinutes: 60,
                        timeoutSeconds: 5,
                        logStatusChanges: false,
                        nextServerId: 2,
                    },
                });

                await setObject(harness, `${prefix}.servers.server1.online`, {
                    type: "state",
                    common: { name: "Account online", type: "boolean", role: "indicator.reachable", read: true, write: false },
                    native: {},
                });
                await setObject(harness, `${prefix}.servers.server1.offlineSince`, {
                    type: "state",
                    common: { name: "Offline since", type: "number", role: "date", read: true, write: false },
                    native: {},
                });
                await setState(harness, `${prefix}.servers.server1.online`, { val: false, ack: true });
                await setState(harness, `${prefix}.servers.server1.offlineSince`, { val: originalOfflineSince, ack: true });

                await harness.startAdapterAndWait(false);

                await waitFor(async () => {
                    const state = await getState(harness, `${prefix}.servers.server1.errorType`);
                    return state?.val === "inactive";
                });

                const offlineSince = await getState(harness, `${prefix}.servers.server1.offlineSince`);
                assert.equal(offlineSince?.val, originalOfflineSince);
            });
        });

        suite("Clean shutdown", getHarness => {
            let mockServer;
            let baseUrl;
            let requestStarted;
            let requestClosed;

            before(async () => {
                let markStarted;
                let markClosed;
                requestStarted = new Promise(resolve => { markStarted = resolve; });
                requestClosed = new Promise(resolve => { markClosed = resolve; });

                mockServer = http.createServer((_request, response) => {
                    markStarted();
                    response.once("close", () => markClosed());
                    // Intentionally keep the response open. The adapter must abort it on unload.
                });
                baseUrl = await listen(mockServer);
            });

            after(async () => {
                if (typeof mockServer.closeAllConnections === "function") {
                    mockServer.closeAllConnections();
                }
                await close(mockServer);
            });

            it("aborts an active HTTP request when the adapter is stopped", async function () {
                this.timeout(10_000);
                const harness = getHarness();

                await harness.changeAdapterConfig(adapterName, {
                    native: {
                        servers: [{
                            enabled: true,
                            id: "server1",
                            name: "Slow test server",
                            host: baseUrl,
                            username: "slow-user",
                            password: "test-secret",
                        }],
                        pollIntervalMinutes: 60,
                        timeoutSeconds: 60,
                        logStatusChanges: false,
                        nextServerId: 2,
                    },
                });

                await harness.startAdapterAndWait(false);
                await Promise.race([
                    requestStarted,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Mock request did not start")), 3000)),
                ]);

                await harness.stopAdapter();

                await Promise.race([
                    requestClosed,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP request was not aborted on unload")), 3000)),
                ]);

                assert.equal(harness.didAdapterStop(), true);
            });
        });
    },
});

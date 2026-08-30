declare global {
    namespace ioBroker {
        interface XtreamMonitorServerConfig {
            enabled?: boolean;
            id?: string;
            name?: string;
            host?: string;
            username?: string;
            password?: string;
        }

        interface AdapterConfig {
            servers: XtreamMonitorServerConfig[];
            pollIntervalMinutes: number;
            timeoutSeconds: number;
            logStatusChanges: boolean;

            // Legacy 0.1.x fields. Used only for a smooth development migration.
            host?: string;
            username?: string;
            password?: string;
        }
    }
}

export {};

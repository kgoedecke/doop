type TelemetryEvent = Record<string, boolean | number | string | undefined>;
type TelemetrySink = (event: TelemetryEvent) => void;
declare class LatencyTimeline {
    private readonly now;
    private readonly origin;
    private readonly milestones;
    constructor(now?: () => number);
    mark(name: string): void;
    finish(): Record<string, number>;
}
export { LatencyTimeline };
export type { TelemetryEvent, TelemetrySink };

class LatencyTimeline {
    now;
    origin;
    milestones = { started_at_ms: 0 };
    constructor(now = () => performance.now()) {
        this.now = now;
        this.origin = this.now();
    }
    mark(name) {
        this.milestones[`${name}_at_ms`] = Math.max(0, Math.round(this.now() - this.origin));
    }
    finish() {
        this.mark("completed");
        return { ...this.milestones };
    }
}
export { LatencyTimeline };

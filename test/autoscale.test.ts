import { describe, it, expect } from "bun:test";
import {
    initialScaleState,
    PROCESS_MEMORY_BYTES,
    processBudget,
    startLoadMeter,
    stepScale,
    type LoadSample,
    type ScaleAction,
    type ScaleConfig,
    type ScaleState,
} from "../src/autoscale";

const config: ScaleConfig = {
    maxProcesses: 4,
    minProcesses: 1,
    hotLagMs: 100,
    hotCpu: 0.8,
    upAfterS: 3,
    downAfterS: 5,
    upCooldownS: 10,
    downCooldownS: 10,
};

const hot: LoadSample = { pending: 0, lagMs: 0, cpu: 0.95 };
const idle: LoadSample = { pending: 0, lagMs: 0, cpu: 0.01 };
const busy: LoadSample = { pending: 0, lagMs: 0, cpu: 0.3 };

/** Feeds one sample set per second (t = 1, 2, …) and records every non-hold decision with its second. */
function simulate(
    perSecond: (t: number) => LoadSample[],
    seconds: number,
    opts: { processes?: number; memoryOk?: boolean; config?: Partial<ScaleConfig> } = {},
) {
    let state: ScaleState = initialScaleState;
    let processes = opts.processes ?? 1;
    const actions: { t: number; action: ScaleAction }[] = [];
    for (let t = 1; t <= seconds; t++) {
        const step = stepScale(state, perSecond(t), processes, t, opts.memoryOk ?? true, { ...config, ...opts.config });
        state = step.state;
        if (step.action === "up") processes++;
        if (step.action === "down") processes--;
        if (step.action !== "hold") actions.push({ t, action: step.action });
    }
    return { actions, processes };
}

const always = (sample: LoadSample) => () => [sample];

describe("stepScale: scale up", () => {
    it("adds one process only after upAfterS consecutive hot seconds", () => {
        expect(simulate(always(hot), 2, { config: { maxProcesses: 9 } }).actions).toEqual([]);
        expect(simulate(always(hot), 3, { config: { maxProcesses: 9 } }).actions).toEqual([{ t: 3, action: "up" }]);
    });

    it("counts a lag-only or cpu-only sample at the threshold as hot, and just below as not", () => {
        expect(simulate(always({ pending: 0, lagMs: 100, cpu: 0 }), 3).actions).toEqual([{ t: 3, action: "up" }]);
        expect(simulate(always({ pending: 0, lagMs: 0, cpu: 0.8 }), 3).actions).toEqual([{ t: 3, action: "up" }]);
        expect(simulate(always({ pending: 0, lagMs: 99, cpu: 0.79 }), 30).actions).toEqual([]);
    });

    it("resets the hot streak on one cool second", () => {
        const seq = [hot, hot, idle, hot, hot];
        expect(simulate((t) => [seq[t - 1]!], seq.length).actions).toEqual([]);
        expect(simulate((t) => [seq[t - 1] ?? hot], seq.length + 1).actions).toEqual([{ t: 6, action: "up" }]);
    });

    it("never adds when in-flight requests alone are huge, since database slowness must not add processes", () => {
        const dbStall: LoadSample = { pending: 1000, lagMs: 0, cpu: 0 };
        expect(simulate(always(dbStall), 60, { processes: 2 }).actions).toEqual([]);
    });

    it("never exceeds maxProcesses", () => {
        expect(simulate(always(hot), 60, { processes: 4 }).actions).toEqual([]);
    });

    it("never adds when the memory check fails", () => {
        expect(simulate(always(hot), 60, { memoryOk: false }).actions).toEqual([]);
    });

    it("waits upCooldownS between additions and adds again once the cooldown has passed", () => {
        const result = simulate(always(hot), 13, { config: { maxProcesses: 10 } });
        expect(result.actions).toEqual([
            { t: 3, action: "up" },
            { t: 13, action: "up" },
        ]);
        expect(result.processes).toBe(3);
    });
});

describe("stepScale: minProcesses", () => {
    it("never retires at or below the minimum, however long it stays quiet", () => {
        expect(simulate(always(idle), 600, { processes: 2, config: { minProcesses: 2 } }).actions).toEqual([]);
    });

    it("retires down to the minimum and stops there", () => {
        const result = simulate(always(idle), 600, { processes: 4, config: { minProcesses: 2 } });
        expect(result.processes).toBe(2);
        expect(result.actions.map((entry) => entry.action)).toEqual(["down", "down"]);
    });

    it("still adds processes above the minimum when hot", () => {
        expect(simulate(always(hot), 3, { processes: 2, config: { minProcesses: 2 } }).actions).toEqual([{ t: 3, action: "up" }]);
    });
});

describe("stepScale: scale down", () => {
    it("removes one process only after downAfterS consecutive quiet seconds", () => {
        expect(simulate(always(idle), 4, { processes: 2 }).actions).toEqual([]);
        expect(simulate(always(idle), 5, { processes: 2 }).actions).toEqual([{ t: 5, action: "down" }]);
    });

    it("counts cpu exactly at the quiet limit as not quiet, and two in-flight requests as still quiet", () => {
        expect(simulate(always({ pending: 0, lagMs: 0, cpu: 0.05 }), 30, { processes: 2 }).actions).toEqual([]);
        expect(simulate(always({ pending: 2, lagMs: 0, cpu: 0 }), 5, { processes: 2 }).actions).toEqual([
            { t: 5, action: "down" },
        ]);
    });

    it("never goes below one process", () => {
        expect(simulate(always(idle), 60, { processes: 1 }).actions).toEqual([]);
    });

    it("waits downCooldownS between removals", () => {
        const result = simulate(always(idle), 15, { processes: 4 });
        expect(result.actions).toEqual([
            { t: 5, action: "down" },
            { t: 15, action: "down" },
        ]);
        expect(result.processes).toBe(2);
    });

    it("resets the quiet streak on one busy second", () => {
        const seq = [idle, idle, idle, idle, busy, idle, idle, idle, idle, idle];
        expect(simulate((t) => [seq[t - 1]!], seq.length, { processes: 2 }).actions).toEqual([{ t: 10, action: "down" }]);
    });

    it("treats in-flight requests above the quiet limit as busy", () => {
        const queued: LoadSample = { pending: 3, lagMs: 0, cpu: 0 };
        const seq = [idle, idle, idle, idle, queued, idle, idle, idle, idle, idle];
        expect(simulate((t) => [seq[t - 1]!], seq.length, { processes: 2 }).actions).toEqual([{ t: 10, action: "down" }]);
    });
});

describe("stepScale: mixed fleets", () => {
    const mixed = [hot, idle];

    it("counts one hot process among idle ones as hot", () => {
        expect(simulate(() => mixed, 3, { processes: 2 }).actions).toEqual([{ t: 3, action: "up" }]);
    });

    it("never counts a mixed fleet as quiet, so it never removes a process", () => {
        expect(simulate(() => mixed, 30, { processes: 2, config: { maxProcesses: 2 } }).actions).toEqual([]);
    });
});

describe("stepScale: spike then silence", () => {
    it("adds one process during a spike and removes it once silence lasts, with no flapping", () => {
        const result = simulate((t) => (t <= 10 ? [hot] : [idle]), 80);
        expect(result.actions).toEqual([
            { t: 3, action: "up" },
            { t: 15, action: "down" },
        ]);
        expect(result.processes).toBe(1);
    });
});

describe("processBudget", () => {
    it("is bounded by the cores when there is no limit", () => {
        expect(processBudget({ cpuLimit: null, memoryLimitBytes: null, cores: 2 })).toBe(2);
    });

    it("is bounded by the configured maximum when that is smaller than the cores", () => {
        expect(processBudget({ cpuLimit: null, memoryLimitBytes: null, cores: 8, configuredMax: 3 })).toBe(3);
    });

    it("rounds a fractional CPU limit up", () => {
        expect(processBudget({ cpuLimit: 1.5, memoryLimitBytes: null, cores: 8, configuredMax: 8 })).toBe(2);
    });

    it("gives one process for a sub-core CPU limit", () => {
        expect(processBudget({ cpuLimit: 0.5, memoryLimitBytes: null, cores: 8, configuredMax: 8 })).toBe(1);
    });

    it("gives one process when the memory limit is below two processes' budget", () => {
        const memoryLimitBytes = 2 * PROCESS_MEMORY_BYTES - 1;
        expect(processBudget({ cpuLimit: null, memoryLimitBytes, cores: 8, configuredMax: 8 })).toBe(1);
    });

    it("takes the smallest of the CPU, memory and configured limits", () => {
        const memoryLimitBytes = 2 * PROCESS_MEMORY_BYTES;
        expect(processBudget({ cpuLimit: 2.5, memoryLimitBytes, cores: 8, configuredMax: 8 })).toBe(2);
        expect(processBudget({ cpuLimit: 3, memoryLimitBytes: 10 * PROCESS_MEMORY_BYTES, cores: 8, configuredMax: 2 })).toBe(2);
    });

    it("never drops below one process, even when memory holds less than one", () => {
        expect(processBudget({ cpuLimit: null, memoryLimitBytes: 1, cores: 8, configuredMax: 8 })).toBe(1);
    });

    it("uses the given per-process memory instead of the default", () => {
        const memoryLimitBytes = 512 * 1024 * 1024;
        expect(processBudget({ cpuLimit: null, memoryLimitBytes, cores: 8, configuredMax: 8, memoryPerProcessBytes: 100 * 1024 * 1024 })).toBe(5);
    });
});

describe("startLoadMeter", () => {
    const burn = (ms: number) => {
        const end = performance.now() + ms;
        let x = 0;
        while (performance.now() < end) x += Math.sqrt(x + 1);
        return x;
    };

    it("reports finite non-negative figures, and more CPU while burning than while idle", async () => {
        const read = startLoadMeter();
        read();
        burn(100);
        const busyRead = read();
        // Real wall clock on purpose: the meter measures real CPU over real elapsed time, so no fake clock applies.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const idleRead = read();

        for (const r of [busyRead, idleRead]) {
            expect(Number.isFinite(r.lagMs) && r.lagMs >= 0).toBe(true);
            expect(Number.isFinite(r.cpu) && r.cpu >= 0).toBe(true);
        }
        expect(busyRead.cpu).toBeGreaterThan(0.5);
        expect(busyRead.cpu).toBeGreaterThan(idleRead.cpu);
    });
});

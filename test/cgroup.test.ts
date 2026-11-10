import { describe, it, expect } from "bun:test";
import { parseCfs, parseCpuMax, parseMemoryLimit } from "../src/cgroup";

describe("parseCpuMax (cgroup v2 cpu.max)", () => {
    it("reads the quota over the period as a CPU count", () => {
        expect(parseCpuMax("200000 100000")).toBe(2);
        expect(parseCpuMax("150000 100000\n")).toBe(1.5);
    });

    it("returns null when there is no quota", () => {
        expect(parseCpuMax("max 100000")).toBeNull();
        expect(parseCpuMax("max")).toBeNull();
    });

    it("returns null for garbage or empty text", () => {
        expect(parseCpuMax("")).toBeNull();
        expect(parseCpuMax("   ")).toBeNull();
        expect(parseCpuMax("lots 100000")).toBeNull();
    });
});

describe("parseCfs (cgroup v1 quota and period)", () => {
    it("reads the quota over the period as a CPU count", () => {
        expect(parseCfs("250000", "100000")).toBe(2.5);
    });

    it("returns null when the quota is -1 (no limit)", () => {
        expect(parseCfs("-1", "100000")).toBeNull();
    });

    it("returns null for garbage input", () => {
        expect(parseCfs("abc", "100000")).toBeNull();
    });
});

describe("parseMemoryLimit", () => {
    it("returns the byte count for a real limit", () => {
        expect(parseMemoryLimit("1073741824\n")).toBe(1073741824);
    });

    it("returns null for an unlimited cgroup v2 value", () => {
        expect(parseMemoryLimit("max")).toBeNull();
    });

    it("returns null for the huge number cgroup v1 writes when unlimited", () => {
        expect(parseMemoryLimit("9223372036854771712")).toBeNull();
    });

    it("returns null for garbage or empty text", () => {
        expect(parseMemoryLimit("")).toBeNull();
        expect(parseMemoryLimit("lots")).toBeNull();
    });
});

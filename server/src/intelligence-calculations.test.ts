import { describe, expect, it } from "vitest";
import {
  calculateBedForecast,
  calculatePatientFlowForecast,
  simulateBedCapacity,
  simulatePatientFlow,
  simulateStaffing,
  type DailyOperations,
} from "./intelligence-calculations.js";

const asOf = new Date("2026-11-23T00:00:00.000Z");
const history: DailyOperations[] = Array.from({ length: 28 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 9, 27 + index)).toISOString().slice(0, 10),
  admissions: index % 2,
  discharges: index % 3 === 0 ? 1 : 0,
  appointments: index % 7 + 4,
}));

describe("explainable operational calculations", () => {
  it("calculates a bounded bed forecast from historical daily flows", () => {
    const result = calculateBedForecast({
      history,
      currentOccupancy: 8,
      totalBeds: 10,
      asOf,
      horizonDays: 2,
      coverageDays: 28,
    });

    expect(result.status).toBe("available");
    expect(result.projection).toHaveLength(2);
    expect(result.projection[0].estimatedOccupiedBeds).toBeGreaterThanOrEqual(0);
    expect(result.projection[0].estimatedOccupiedBeds).toBeLessThanOrEqual(10);
    expect(result.formula).toContain("admissions - historical daily discharges");
  });

  it("does not forecast when history coverage is insufficient", () => {
    const result = calculateBedForecast({
      history: history.slice(0, 5),
      currentOccupancy: 2,
      totalBeds: 8,
      asOf,
      horizonDays: 7,
      coverageDays: 5,
    });

    expect(result.status).toBe("insufficient_history");
    expect(result.projection).toEqual([]);
    expect(result.averageAdmissionsPerDay).toBeNull();
  });

  it("uses weekday samples and marks days with inadequate history unavailable", () => {
    const result = calculatePatientFlowForecast({ history, asOf, horizonDays: 7, coverageDays: 28 });

    expect(result.status).toBe("available");
    expect(result.projection.every((day) => day.status === "available")).toBe(true);
    expect(result.projection.every((day) => day.sampleDays >= 2)).toBe(true);

    const sparse = calculatePatientFlowForecast({ history: history.slice(0, 6), asOf, horizonDays: 7, coverageDays: 6 });
    expect(sparse.status).toBe("partial");
    expect(sparse.projection.every((day) => day.appointments === null)).toBe(true);
  });

  it("simulates bed capacity without exceeding beds and reports overflow", () => {
    const result = simulateBedCapacity({
      currentOccupancy: 4,
      totalBeds: 5,
      admissionsPerDay: 2,
      dischargesPerDay: 0,
      horizonDays: 2,
    });

    expect(result).toEqual([
      { day: 1, estimatedOccupiedBeds: 5, estimatedAvailableBeds: 0, demandAboveCapacity: 1 },
      { day: 2, estimatedOccupiedBeds: 5, estimatedAvailableBeds: 0, demandAboveCapacity: 3 },
    ]);
  });

  it("handles zero staffing without division by zero", () => {
    expect(simulatePatientFlow({ dailyAppointments: 3, availableClinicians: 0, appointmentsPerClinician: 8 })).toMatchObject({
      dailyCapacity: 0,
      utilizationPercent: null,
      pressure: "high",
    });
    expect(simulateStaffing({
      departments: [{ departmentId: "d1", departmentName: "General", workload: 4, onDutyDoctors: 2 }],
      appointmentChangePercent: 0,
      staffingChangePercent: -100,
      overloadThreshold: 8,
    })[0].pressure).toBe("critical");
  });
});

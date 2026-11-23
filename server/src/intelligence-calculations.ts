export type DailyOperations = {
  date: string;
  admissions: number;
  discharges: number;
  appointments: number;
};

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, count: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + count));
}

function dataCoverage(coverageDays: number) {
  if (coverageDays >= 28) return "strong";
  if (coverageDays >= 14) return "moderate";
  if (coverageDays >= 7) return "limited";
  return "insufficient";
}

export function calculateBedForecast(input: {
  history: DailyOperations[];
  currentOccupancy: number;
  totalBeds: number;
  asOf: Date;
  horizonDays: number;
  coverageDays: number;
}) {
  const usable = input.totalBeds > 0 && input.coverageDays >= 7 && input.history.length >= 7;
  const days = Math.max(1, input.history.length);
  const admissionsPerDay = input.history.reduce((sum, item) => sum + item.admissions, 0) / days;
  const dischargesPerDay = input.history.reduce((sum, item) => sum + item.discharges, 0) / days;
  let projectedDemand = input.currentOccupancy;
  const projection = Array.from({ length: input.horizonDays }, (_, index) => {
    projectedDemand += admissionsPerDay - dischargesPerDay;
    const estimatedOccupiedBeds = Math.max(0, Math.min(input.totalBeds, Math.round(projectedDemand)));
    return {
      date: dateKey(addDays(input.asOf, index + 1)),
      estimatedOccupiedBeds,
      estimatedAvailableBeds: input.totalBeds - estimatedOccupiedBeds,
      estimatedDemand: Math.max(0, Math.round(projectedDemand)),
      projectedAboveCapacity: Math.max(0, Math.round(projectedDemand) - input.totalBeds),
    };
  });
  return {
    status: usable ? "available" as const : "insufficient_history" as const,
    coverageDays: input.coverageDays,
    coverage: dataCoverage(input.coverageDays),
    formula: "Current active admissions + cumulative (historical daily admissions - historical daily discharges); occupancy is capped at current bed capacity.",
    averageAdmissionsPerDay: usable ? Number(admissionsPerDay.toFixed(2)) : null,
    averageDischargesPerDay: usable ? Number(dischargesPerDay.toFixed(2)) : null,
    projection: usable ? projection : [],
  };
}

export function calculatePatientFlowForecast(input: {
  history: DailyOperations[];
  asOf: Date;
  horizonDays: number;
  coverageDays: number;
}) {
  const byWeekday = new Map<number, DailyOperations[]>();
  for (const day of input.history) {
    const weekday = new Date(`${day.date}T00:00:00.000Z`).getUTCDay();
    byWeekday.set(weekday, [...(byWeekday.get(weekday) ?? []), day]);
  }
  const projection = Array.from({ length: input.horizonDays }, (_, index) => {
    const date = addDays(input.asOf, index + 1);
    const samples = byWeekday.get(date.getUTCDay()) ?? [];
    if (input.coverageDays < 14 || samples.length < 2) {
      return { date: dateKey(date), status: "insufficient_history" as const, appointments: null, admissions: null, sampleDays: samples.length };
    }
    return {
      date: dateKey(date),
      status: "available" as const,
      appointments: Math.round(samples.reduce((sum, item) => sum + item.appointments, 0) / samples.length),
      admissions: Math.round(samples.reduce((sum, item) => sum + item.admissions, 0) / samples.length),
      sampleDays: samples.length,
    };
  });
  return {
    status: projection.every((day) => day.status === "available") ? "available" as const : "partial" as const,
    coverageDays: input.coverageDays,
    coverage: dataCoverage(input.coverageDays),
    formula: "For each future weekday, take the arithmetic mean of appointment and admission counts on that weekday in the selected historical period; round to the nearest whole visit.",
    projection,
  };
}

export function simulateBedCapacity(input: {
  currentOccupancy: number;
  totalBeds: number;
  admissionsPerDay: number;
  dischargesPerDay: number;
  horizonDays: number;
}) {
  let demand = input.currentOccupancy;
  return Array.from({ length: input.horizonDays }, (_, index) => {
    demand = Math.max(0, demand + input.admissionsPerDay - input.dischargesPerDay);
    const occupancy = Math.min(input.totalBeds, demand);
    return {
      day: index + 1,
      estimatedOccupiedBeds: occupancy,
      estimatedAvailableBeds: Math.max(0, input.totalBeds - occupancy),
      demandAboveCapacity: Math.max(0, Math.round(demand - input.totalBeds)),
    };
  });
}

export function simulatePatientFlow(input: {
  dailyAppointments: number;
  availableClinicians: number;
  appointmentsPerClinician: number;
}) {
  const capacity = input.availableClinicians * input.appointmentsPerClinician;
  const utilizationPercent = capacity === 0 ? (input.dailyAppointments > 0 ? null : 0) : (input.dailyAppointments / capacity) * 100;
  return {
    dailyAppointments: input.dailyAppointments,
    dailyCapacity: capacity,
    utilizationPercent: utilizationPercent === null ? null : Number(utilizationPercent.toFixed(1)),
    pressure: utilizationPercent === null || utilizationPercent >= 100 ? "high" as const : utilizationPercent >= 80 ? "elevated" as const : "within_scenario_capacity" as const,
  };
}

export function simulateStaffing(input: {
  departments: Array<{ departmentId: string; departmentName: string; workload: number; onDutyDoctors: number }>;
  appointmentChangePercent: number;
  staffingChangePercent: number;
  overloadThreshold: number;
}) {
  return input.departments.map((department) => {
    const adjustedWorkload = department.workload * (1 + input.appointmentChangePercent / 100);
    const adjustedStaff = department.onDutyDoctors * (1 + input.staffingChangePercent / 100);
    const workloadPerDoctor = adjustedStaff > 0 ? adjustedWorkload / adjustedStaff : null;
    return {
      departmentId: department.departmentId,
      departmentName: department.departmentName,
      workload: Number(adjustedWorkload.toFixed(1)),
      onDutyDoctors: Number(adjustedStaff.toFixed(1)),
      workloadPerDoctor: workloadPerDoctor === null ? null : Number(workloadPerDoctor.toFixed(2)),
      pressure: workloadPerDoctor === null
        ? adjustedWorkload > 0 ? "critical" as const : "no_workload" as const
        : workloadPerDoctor >= input.overloadThreshold ? "high" as const : "within_scenario_threshold" as const,
    };
  });
}

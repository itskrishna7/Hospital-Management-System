import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AxiosInstance } from "axios";
import { useMemo, useState, type FormEvent } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./intelligence.css";

type Props = { api: AxiosInstance; userRole: string };
type Department = { id: string; name: string };
type Metric = { status: "available" | "unavailable"; value: number | null; unit: string; sampleCount: number; formula: string; reason?: string };
type Workload = { departmentId: string; departmentName: string; appointments: number; activeAdmissions: number; pendingLabs: number; activeQueue: number; onDutyDoctors: number; workload: number; workloadPerOnDutyDoctor?: number | null; pressure?: string };
type Analytics = {
  dateRange: { startDate: string; endDate: string };
  metrics: Record<string, Metric | null>;
  departmentWorkload: Workload[];
  inventoryConsumption: { status: string; dailyUnitsConsumed?: Array<{ date: string; units: number }>; transactionCount?: number; formula?: string; reason?: string };
};
type Forecasts = {
  generatedAt: string;
  estimatesOnly: true;
  historicalPeriod: { startDate: string; endDate: string; days: number };
  bedOccupancy: {
    status: string;
    coverage?: string;
    coverageDays?: number;
    formula: string;
    historicalTrend: Array<{ date: string; occupiedBeds: number; availableBeds: number }>;
    projection: Array<{ date: string; estimatedOccupiedBeds: number; estimatedAvailableBeds: number }>;
  };
  patientFlow: { status: string; coverage?: string; coverageDays?: number; formula: string; projection: Array<{ date: string; status: string; appointments: number | null; admissions: number | null }> };
  departmentWorkload: Workload[];
  inventory: { status: string; reason?: string; forecasts?: Array<{ name: string; sku: string; currentStock: number; status: string; estimatedDaysRemaining: number | null; estimatedDailyConsumption: number | null; sampleTransactions: number; sampleDays: number; formula: string; reason?: string }> };
};
type Alert = { id: string; category: string; severity: string; status: string; title: string; description: string; createdAt: string; department: Department | null };
type AlertRule = { key: string; label: string; description: string; unit: string; threshold: number; enabled: boolean };
type Briefing = { date: string; patientsToday: number; appointmentsToday: number; currentAdmissions: number; beds: { total: number; available: number; occupied: number }; pendingLaboratoryOrders: number; pendingDischarges: number; outstandingInvoices?: { count: number; balance: number }; inventory?: { lowStockMedicines: number; outOfStockMedicines: number; expiringMedicines: number } };

const adminRoles = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN"];
const metricLabels: Record<string, string> = {
  averageWaitingTime: "Average waiting time",
  appointmentCompletionRate: "Appointment completion",
  bedOccupancyRate: "Bed occupancy",
  averageLengthOfStay: "Average length of stay",
  averageDischargeProcessingTime: "Discharge processing",
  averageLaboratoryTurnaround: "Lab turnaround",
  averagePharmacyFulfillmentTime: "Pharmacy fulfilment",
  billingCollectionRate: "Billing collection",
};

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function formatMetric(value: Metric | null) {
  if (!value || value.status !== "available" || value.value === null) return "Unavailable";
  return `${value.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${value.unit}`;
}

function QueryError({ message }: { message: string }) {
  return <p className="intelligence-error" role="alert">{message}</p>;
}

export default function IntelligenceWorkspace({ api, userRole }: Props) {
  const queryClient = useQueryClient();
  const isAdmin = adminRoles.includes(userRole);
  const isFinance = [...adminRoles, "BILLING_STAFF", "ACCOUNTANT"].includes(userRole);
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    return date.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(todayString);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [briefingDate, setBriefingDate] = useState(todayString);
  const [simulationKind, setSimulationKind] = useState("bed_capacity");
  const [simulationResult, setSimulationResult] = useState<unknown>(null);
  const [simulationError, setSimulationError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  const departmentQuery = useQuery<Department[]>({
    queryKey: ["intelligence", "departments"],
    queryFn: () => api.get("/intelligence/departments").then((response) => response.data.data),
  });
  const filters = useMemo(() => ({
    startDate,
    endDate,
    ...(selectedDepartment ? { departmentId: selectedDepartment } : {}),
  }), [startDate, endDate, selectedDepartment]);
  const analyticsQuery = useQuery<Analytics>({
    queryKey: ["intelligence", "analytics", filters],
    queryFn: () => api.get("/intelligence/analytics", { params: filters }).then((response) => response.data.data),
  });
  const forecastQuery = useQuery<Forecasts>({
    queryKey: ["intelligence", "forecasts", selectedDepartment],
    queryFn: () => api.get("/intelligence/forecasts", { params: selectedDepartment ? { departmentId: selectedDepartment } : {} }).then((response) => response.data.data),
  });
  const briefingQuery = useQuery<Briefing>({
    queryKey: ["intelligence", "briefing", briefingDate, selectedDepartment],
    queryFn: () => api.get("/intelligence/briefing", { params: { date: briefingDate, ...(selectedDepartment ? { departmentId: selectedDepartment } : {}) } }).then((response) => response.data.data),
  });
  const alertsQuery = useQuery<{ items: Alert[]; total: number }>({
    queryKey: ["intelligence", "alerts", selectedDepartment],
    queryFn: () => api.get("/intelligence/alerts", { params: { limit: 50, ...(selectedDepartment ? { departmentId: selectedDepartment } : {}) } }).then((response) => response.data.data),
    refetchInterval: 30_000,
  });
  const rulesQuery = useQuery<AlertRule[]>({
    queryKey: ["intelligence", "alert-rules"],
    queryFn: () => api.get("/intelligence/alert-rules").then((response) => response.data.data),
    enabled: isAdmin,
  });

  const refreshAlerts = useMutation({
    mutationFn: () => api.post("/intelligence/alerts/refresh"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intelligence", "alerts"] }),
  });
  const alertAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "acknowledge" | "resolve" }) => api.patch(`/intelligence/alerts/${id}/${action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intelligence", "alerts"] }),
  });
  const updateRule = useMutation({
    mutationFn: ({ key, enabled, threshold }: { key: string; enabled: boolean; threshold: number }) =>
      api.patch(`/intelligence/alert-rules/${key}`, { enabled, threshold }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intelligence", "alert-rules"] }),
  });

  const alertItems = alertsQuery.data?.items ?? [];
  const chartData = [
    ...(forecastQuery.data?.bedOccupancy.historicalTrend ?? []).map((day) => ({
      date: day.date.slice(5),
      occupied: day.occupiedBeds,
      available: day.availableBeds,
      estimated: null as number | null,
      estimatedAvailable: null as number | null,
    })),
    ...(forecastQuery.data?.bedOccupancy.projection ?? []).map((day) => ({
      date: day.date.slice(5),
      occupied: null as number | null,
      available: null as number | null,
      estimated: day.estimatedOccupiedBeds,
      estimatedAvailable: day.estimatedAvailableBeds,
    })),
  ];
  const alertSeverityCounts = alertItems.reduce((counts, alert) => {
    counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  async function exportBriefing() {
    setExportError("");
    setExporting(true);
    try {
      const response = await api.get("/intelligence/briefing", {
        params: { date: briefingDate, format: "csv", ...(selectedDepartment ? { departmentId: selectedDepartment } : {}) },
        responseType: "blob",
      });
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mediverse-briefing-${briefingDate}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("The briefing export failed. Please retry.");
    } finally {
      setExporting(false);
    }
  }

  async function runSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSimulationError("");
    setSimulationResult(null);
    const values = new FormData(event.currentTarget);
    let input: Record<string, string | number> = { kind: simulationKind };
    if (simulationKind === "bed_capacity") {
      input = {
        ...input,
        admissionsPerDay: Number(values.get("admissionsPerDay")),
        dischargesPerDay: Number(values.get("dischargesPerDay")),
        horizonDays: Number(values.get("horizonDays")),
      };
    } else if (simulationKind === "patient_flow") {
      input = {
        ...input,
        dailyAppointments: Number(values.get("dailyAppointments")),
        availableClinicians: Number(values.get("availableClinicians")),
        appointmentsPerClinician: Number(values.get("appointmentsPerClinician")),
      };
    } else {
      input = {
        ...input,
        appointmentChangePercent: Number(values.get("appointmentChangePercent")),
        staffingChangePercent: Number(values.get("staffingChangePercent")),
        ...(selectedDepartment ? { departmentId: selectedDepartment } : {}),
      };
    }
    try {
      const response = await api.post("/intelligence/simulations", input);
      setSimulationResult(response.data.data);
    } catch {
      setSimulationError("The hypothetical scenario could not be calculated. Check the inputs and your access.");
    }
  }

  const data = analyticsQuery.data;
  const briefing = briefingQuery.data;
  const metrics = data?.metrics ?? {};

  return (
    <div className="intelligence-workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">DATA-DRIVEN OPERATIONS · AI-FREE</p>
          <h1>Intelligence &amp; Analytics</h1>
          <p className="muted">Explainable calculations from MediVerse records. Forecasts are estimates, not guaranteed outcomes or clinical advice.</p>
        </div>
        {isAdmin && <button className="primary" onClick={() => refreshAlerts.mutate()} disabled={refreshAlerts.isPending}>{refreshAlerts.isPending ? "Checking rules…" : "Run alert checks"}</button>}
      </div>

      <section className="panel intelligence-filters">
        <label>From<input type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>Through<input type="date" value={endDate} min={startDate} max={todayString()} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>Department<select value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)}><option value="">All departments</option>{(departmentQuery.data ?? []).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <p>Analytics are limited to a maximum 366-day range. Department access is enforced by the API.</p>
      </section>

      {(analyticsQuery.isError || forecastQuery.isError || briefingQuery.isError || alertsQuery.isError) && (
        <QueryError message="Some intelligence data could not be loaded. Verify your connection and permissions, then retry." />
      )}

      <div className="intelligence-section-heading">
        <div><p className="eyebrow">OPERATIONS BRIEFING</p><h2>Hospital today</h2></div>
        <div className="intelligence-actions">
          <label className="intelligence-date">Briefing date<input type="date" value={briefingDate} max={todayString()} onChange={(event) => setBriefingDate(event.target.value)} /></label>
          <button className="secondary" onClick={() => void exportBriefing()} disabled={exporting}>{exporting ? "Exporting…" : "Export CSV"}</button>
        </div>
      </div>
      {exportError && <QueryError message={exportError}/>}
      {briefingQuery.isLoading && !briefing && <div className="panel intelligence-empty">Loading the database-backed briefing…</div>}
      {briefing && <div className="intelligence-cards">
        {[
          ["Unique patients today", briefing.patientsToday],
          ["Appointments today", briefing.appointmentsToday],
          ["Current admissions", briefing.currentAdmissions],
          ["Beds occupied / available", `${briefing.beds.occupied} / ${briefing.beds.available}`],
          ["Pending lab orders", briefing.pendingLaboratoryOrders],
          ["Pending approved discharges", briefing.pendingDischarges],
          ...(briefing.inventory ? [["Low-stock medicines", briefing.inventory.lowStockMedicines], ["Out-of-stock medicines", briefing.inventory.outOfStockMedicines], ["Expiring medicines", briefing.inventory.expiringMedicines]] as Array<[string, number]> : []),
          ...(briefing.outstandingInvoices && isFinance ? [["Outstanding invoices", `${briefing.outstandingInvoices.count} · ${briefing.outstandingInvoices.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}`]] as Array<[string, string]> : []),
        ].map(([label, value]) => <div className="intelligence-card" key={label}><small>{label}</small><strong>{value}</strong></div>)}
      </div>}
      {briefingQuery.isError && <QueryError message="The selected date's briefing is unavailable." />}

      <div className="intelligence-grid">
        <section className="panel intelligence-panel">
          <div className="panel-title"><div><p className="eyebrow">ESTIMATE · NOT A GUARANTEE</p><h2>Bed occupancy trend &amp; forecast</h2></div><span className="badge">{forecastQuery.data?.bedOccupancy.status ?? "Loading"}</span></div>
          {forecastQuery.isLoading && <div className="intelligence-empty">Loading trend…</div>}
          {chartData.length > 0 ? <div className="intelligence-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData}><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3"/><XAxis dataKey="date" stroke="var(--chart-label)"/><YAxis allowDecimals={false} stroke="var(--chart-label)"/><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}/><Line type="monotone" dataKey="occupied" name="Historical occupied beds" stroke="var(--chart-primary)" connectNulls={false}/><Line type="monotone" dataKey="available" name="Historical available beds" stroke="var(--chart-secondary)" connectNulls={false}/><Line type="monotone" dataKey="estimated" name="Estimated occupied beds" stroke="var(--chart-tertiary)" strokeDasharray="5 5" connectNulls={false}/><Line type="monotone" dataKey="estimatedAvailable" name="Estimated available beds" stroke="var(--chart-warning)" strokeDasharray="5 5" connectNulls={false}/></LineChart></ResponsiveContainer></div> : <div className="intelligence-empty">Insufficient historical bed data for a trend.</div>}
          <p className="intelligence-formula">{forecastQuery.data?.bedOccupancy.formula ?? "Historical daily admissions/discharges projected from current occupancy."}</p>
          <p className="intelligence-note">History: {forecastQuery.data?.historicalPeriod.startDate ?? "—"} to {forecastQuery.data?.historicalPeriod.endDate ?? "—"} · {forecastQuery.data?.bedOccupancy.coverageDays ?? 0} days with recorded activity · {forecastQuery.data?.bedOccupancy.coverage ?? "coverage unavailable"} coverage. Current bed capacity may differ from historical capacity.</p>
        </section>
        <section className="panel intelligence-panel">
          <div className="panel-title"><div><p className="eyebrow">ESTIMATE · WEEKDAY AVERAGES</p><h2>Patient flow forecast</h2></div><span className="badge">{forecastQuery.data?.patientFlow.status ?? "Loading"}</span></div>
          {forecastQuery.data?.patientFlow.projection.some((day) => day.appointments !== null) ? <div className="intelligence-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={forecastQuery.data.patientFlow.projection}><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3"/><XAxis dataKey="date" stroke="var(--chart-label)"/><YAxis allowDecimals={false} stroke="var(--chart-label)"/><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}/><Bar dataKey="appointments" name="Estimated appointments" fill="var(--chart-secondary)" radius={[4, 4, 0, 0]}/><Bar dataKey="admissions" name="Estimated admissions" fill="var(--chart-primary)" radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer></div> : <div className="intelligence-empty">Insufficient weekday samples to estimate patient flow.</div>}
          <p className="intelligence-formula">{forecastQuery.data?.patientFlow.formula}</p>
          <p className="intelligence-note">Historical coverage: {forecastQuery.data?.patientFlow.coverageDays ?? 0} active days · {forecastQuery.data?.patientFlow.coverage ?? "unavailable"}.</p>
        </section>
      </div>

      <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">RECORDED OUTBOUND TRANSACTIONS</p><h2>Inventory forecast</h2></div><span className="badge">{forecastQuery.data?.inventory.status ?? "Loading"}</span></div>
        {forecastQuery.data?.inventory.forecasts?.length ? <div className="intelligence-table-wrap"><table className="intelligence-table"><thead><tr><th>Medicine</th><th>Current stock</th><th>Estimated daily use</th><th>Estimated days remaining</th><th>Confidence / limitation</th></tr></thead><tbody>{forecastQuery.data.inventory.forecasts.map((item) => <tr key={item.sku}><td>{item.name}<small className="intelligence-table-sub">{item.sku}</small></td><td>{item.currentStock}</td><td>{item.estimatedDailyConsumption ?? "Unavailable"}</td><td>{item.estimatedDaysRemaining ?? "Unavailable"}</td><td>{item.status === "available" ? `${item.sampleTransactions} transactions across ${item.sampleDays} days` : item.reason}<details><summary>Calculation method</summary><span>{item.formula}</span></details></td></tr>)}</tbody></table></div> : <div className="intelligence-empty">{forecastQuery.data?.inventory.reason ?? "No reliable medicine-consumption estimates are available. Prescriptions are not treated as dispensing."}</div>}
        <p className="intelligence-note">Stock-duration estimates use only dated negative inventory transactions in the selected historical lookback. They are estimates, not guaranteed availability.</p>
      </section>

      <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">STAFFING PRESSURE INDICATORS</p><h2>Department workload today</h2></div></div>
        {forecastQuery.data?.departmentWorkload.length ? <div className="intelligence-table-wrap"><table className="intelligence-table"><thead><tr><th>Department</th><th>Workload items</th><th>On-duty doctors</th><th>Items per doctor</th><th>Indicator</th></tr></thead><tbody>{forecastQuery.data.departmentWorkload.map((department) => <tr key={department.departmentId}><td>{department.departmentName}</td><td>{department.workload}</td><td>{department.onDutyDoctors}</td><td>{department.workloadPerOnDutyDoctor ?? "Unavailable"}</td><td>{department.pressure}</td></tr>)}</tbody></table></div> : <div className="intelligence-empty">No workload data is available for this department scope.</div>}
        <p className="intelligence-note">This operational ratio is not a staffing recommendation. Formula: today's non-cancelled appointments plus active admissions, divided by on-duty doctors.</p>
      </section>

      <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">DATE-RANGE PERFORMANCE</p><h2>Operational metrics</h2></div><span className="badge">{startDate} — {endDate}</span></div>
        {analyticsQuery.isLoading && !data ? <div className="intelligence-empty">Calculating metrics…</div> : <div className="intelligence-metrics">
          {Object.entries(metricLabels).map(([key, label]) => {
            const metric = metrics[key];
            return <article className="intelligence-metric" key={key}><small>{label}</small><strong>{formatMetric(metric)}</strong><p>{metric?.reason ?? `Samples: ${metric?.sampleCount ?? 0}`}</p><details><summary>Calculation method</summary><p>{metric?.formula ?? "Unavailable for this role."}</p></details></article>;
          })}
        </div>}
        <h3>Department workload</h3>
        {data?.departmentWorkload.length ? <div className="intelligence-table-wrap"><table className="intelligence-table"><thead><tr><th>Department</th><th>Appointments</th><th>Admissions</th><th>Pending labs</th><th>Queue</th><th>On-duty doctors</th><th>Workload / doctor</th></tr></thead><tbody>{data.departmentWorkload.map((department) => <tr key={department.departmentId}><td>{department.departmentName}</td><td>{department.appointments}</td><td>{department.activeAdmissions}</td><td>{department.pendingLabs}</td><td>{department.activeQueue}</td><td>{department.onDutyDoctors}</td><td>{department.workloadPerOnDutyDoctor ?? "Unavailable"}</td></tr>)}</tbody></table></div> : <p className="intelligence-empty">No department workload data is available in this range.</p>}
        {data?.inventoryConsumption.status === "available" && data.inventoryConsumption.dailyUnitsConsumed?.length ? <>
          <h3>Recorded inventory consumption</h3>
          <div className="intelligence-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.inventoryConsumption.dailyUnitsConsumed}><CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3"/><XAxis dataKey="date" stroke="var(--chart-label)"/><YAxis allowDecimals={false} stroke="var(--chart-label)"/><Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}/><Bar dataKey="units" name="Recorded units consumed" fill="var(--chart-primary)" radius={[4, 4, 0, 0]}/></BarChart></ResponsiveContainer></div>
          <p className="intelligence-formula">{data.inventoryConsumption.formula} · {data.inventoryConsumption.transactionCount ?? 0} transactions.</p>
        </> : <p className="intelligence-note">{data?.inventoryConsumption.reason ?? "No recorded outbound inventory transactions exist in this date range."}</p>}
      </section>

      <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">RULE-BASED · DATABASE-GENERATED</p><h2>Operational alerts</h2></div><span className="badge">{alertsQuery.data?.total ?? 0} open</span></div>
        <div className="intelligence-alert-summary">
          <div><small>Visible active alerts</small><strong>{alertItems.length}</strong></div>
          <div><small>Critical</small><strong>{alertSeverityCounts.CRITICAL ?? 0}</strong></div>
          <div><small>Warning</small><strong>{alertSeverityCounts.WARNING ?? 0}</strong></div>
          <div><small>Info</small><strong>{alertSeverityCounts.INFO ?? 0}</strong></div>
        </div>
        {alertsQuery.isLoading && <div className="intelligence-empty">Loading alerts…</div>}
        {!alertsQuery.isLoading && alertItems.length === 0 && <div className="intelligence-empty">No active alerts are available for this role and scope.</div>}
        <div className="intelligence-alerts">{alertItems.map((alert) => <article className={`intelligence-alert ${alert.severity.toLowerCase()}`} key={alert.id}>
          <div><div className="intelligence-alert-meta"><span>{alert.severity}</span><span>{alert.category}</span><span>{alert.department?.name ?? "Hospital-wide"}</span><time>{new Date(alert.createdAt).toLocaleString()}</time></div><strong>{alert.title}</strong><p>{alert.description}</p></div>
          <div className="intelligence-actions">{alert.status === "OPEN" && <button className="secondary" onClick={() => alertAction.mutate({ id: alert.id, action: "acknowledge" })} disabled={alertAction.isPending}>Acknowledge</button>}{isAdmin && alert.status !== "RESOLVED" && <button className="secondary" onClick={() => alertAction.mutate({ id: alert.id, action: "resolve" })} disabled={alertAction.isPending}>Resolve</button>}</div>
        </article>)}</div>
        {refreshAlerts.isError && <QueryError message="Alert generation failed. No success was reported." />}
        {alertAction.isError && <QueryError message="The alert could not be updated." />}
      </section>

      {isAdmin && <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">CONFIGURABLE THRESHOLDS</p><h2>Alert rule settings</h2></div></div>
        {rulesQuery.isLoading && <div className="intelligence-empty">Loading rule settings…</div>}
        <div className="intelligence-rules">{(rulesQuery.data ?? []).map((rule) => <form className="intelligence-rule" key={rule.key} onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          updateRule.mutate({ key: rule.key, enabled: form.get("enabled") === "on", threshold: Number(form.get("threshold")) });
        }}>
          <div><strong>{rule.label}</strong><p>{rule.description}</p></div>
          <label>Threshold ({rule.unit})<input name="threshold" type="number" min="0" max={rule.unit === "percent" ? "100" : "10000"} step="any" defaultValue={rule.threshold}/></label>
          <label className="intelligence-toggle"><input name="enabled" type="checkbox" defaultChecked={rule.enabled}/>Enabled</label>
          <button className="secondary" disabled={updateRule.isPending}>Save</button>
        </form>)}</div>
        {rulesQuery.isError && <QueryError message="Alert rule settings are unavailable." />}
        {updateRule.isError && <QueryError message="The alert rule could not be saved." />}
      </section>}

      <section className="panel intelligence-panel">
        <div className="panel-title"><div><p className="eyebrow">HYPOTHETICAL · NO REAL RECORDS CHANGED</p><h2>Operational simulation</h2></div><span className="badge">SCENARIO ONLY</span></div>
        <form className="intelligence-simulation" onSubmit={(event) => void runSimulation(event)}>
          <label>Scenario<select value={simulationKind} onChange={(event) => { setSimulationKind(event.target.value); setSimulationResult(null); }}>
            <option value="bed_capacity">Bed capacity</option><option value="patient_flow">Patient flow</option><option value="staffing">Staffing scenario</option>
          </select></label>
          {simulationKind === "bed_capacity" && <>
            <label>Admissions per day<input name="admissionsPerDay" type="number" min="0" max="500" defaultValue="3"/></label>
            <label>Discharges per day<input name="dischargesPerDay" type="number" min="0" max="500" defaultValue="2"/></label>
            <label>Horizon (days)<input name="horizonDays" type="number" min="1" max="30" defaultValue="7"/></label>
          </>}
          {simulationKind === "patient_flow" && <>
            <label>Daily appointments<input name="dailyAppointments" type="number" min="0" max="10000" defaultValue="50"/></label>
            <label>Available clinicians<input name="availableClinicians" type="number" min="0" max="1000" defaultValue="8"/></label>
            <label>Appointments per clinician<input name="appointmentsPerClinician" type="number" min="1" max="100" defaultValue="8"/></label>
          </>}
          {simulationKind === "staffing" && <>
            <label>Appointment change (%)<input name="appointmentChangePercent" type="number" min="-100" max="200" defaultValue="0"/></label>
            <label>Staffing change (%)<input name="staffingChangePercent" type="number" min="-100" max="200" defaultValue="0"/></label>
          </>}
          <button className="primary">Run hypothetical scenario</button>
        </form>
        {simulationError && <QueryError message={simulationError}/>}
        {simulationResult !== null && <pre className="intelligence-result">{JSON.stringify(simulationResult, null, 2) ?? ""}</pre>}
        <p className="intelligence-note">Simulation results are hypothetical estimates based on the stated inputs and current aggregate baselines only; they do not update hospital records.</p>
      </section>
    </div>
  );
}

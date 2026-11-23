import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Activity, BedDouble, Bell, CalendarDays, Check, ChevronRight, ClipboardList, Edit3, Eye, EyeOff, FileText, FlaskConical, LayoutDashboard, LogOut, Menu, MessageCircle, Moon, PanelLeftClose, PanelLeftOpen, Pill, Save, Search, ShieldCheck, Siren, Stethoscope, Sun, Users, WalletCards, X, type LucideIcon } from "lucide-react";
import ClinicalWorkspace from "./clinical.js";
import PortalWorkspace, { PatientFamilyInvitation, PatientPortalRegistration } from "./portal.js";
import OperationsWorkspace from "./operations.js";
import DischargeWorkspace from "./discharges.js";
import StaffNotifications from "./staff-notifications.js";
const IntelligenceWorkspace = React.lazy(() => import("./intelligence.js"));
import "./styles.css";
import "./design-system.css";
import "./premium-redesign.css";

const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? "/api/v1" : "http://localhost:4000/api/v1"), withCredentials: true });
const demoEnabled = import.meta.env.DEV && import.meta.env.VITE_APP_MODE !== "production";
const queryClient = new QueryClient();
api.interceptors.response.use(undefined, error => {
  const url = String(error.config?.url ?? "");
  if (error.response?.status === 401 && !url.includes("/auth/login") && !url.endsWith("/auth/me") && !url.includes("/auth/mfa/verify")) {
    window.dispatchEvent(new Event("mediverse:session-expired"));
  }
  return Promise.reject(error);
});
const nav: { label: string; icon: LucideIcon }[] = [{ label: "Dashboard", icon: LayoutDashboard }, { label: "Patients", icon: Users }, { label: "Doctors & Staff", icon: Stethoscope }, { label: "Appointments", icon: CalendarDays }, { label: "Admissions & Discharges", icon: BedDouble }, { label: "Clinical Records", icon: FileText }, { label: "Prescriptions", icon: Pill }, { label: "Nursing", icon: ClipboardList }, { label: "Emergency", icon: Siren }, { label: "Patient Portal", icon: Users }, { label: "Family Access", icon: ShieldCheck }, { label: "Notifications", icon: MessageCircle }, { label: "Staff Alerts", icon: Bell }, { label: "Check-In Desk", icon: Check }, { label: "Pharmacy", icon: Pill }, { label: "Laboratory", icon: FlaskConical }, { label: "Billing & Payments", icon: WalletCards }, { label: "Operations", icon: ClipboardList }, { label: "Intelligence", icon: Activity }, { label: "Security", icon: ShieldCheck }];
const navGroups = [
  { label: "Workspace", items: ["Dashboard"] },
  { label: "Care delivery", items: ["Patients", "Doctors & Staff", "Appointments", "Admissions & Discharges", "Clinical Records", "Prescriptions", "Nursing", "Emergency", "Patient Portal", "Family Access"] },
  { label: "Hospital operations", items: ["Check-In Desk", "Staff Alerts", "Notifications", "Pharmacy", "Laboratory", "Billing & Payments", "Operations", "Intelligence"] },
  { label: "Account", items: ["Security"] },
];
const pageRoles: Record<string, string[]> = {
  Dashboard: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "PHARMACIST", "LAB_TECHNICIAN", "RADIOLOGIST", "BILLING_STAFF", "ACCOUNTANT", "HOUSEKEEPING"],
  Patients: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST"],
  "Doctors & Staff": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN"],
  Appointments: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "RECEPTIONIST"],
  "Admissions & Discharges": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE"],
  "Clinical Records": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE"],
  Prescriptions: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "PHARMACIST"],
  Nursing: ["DOCTOR", "NURSE"],
  Emergency: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST"],
  "Patient Portal": ["PATIENT"],
  "Family Access": ["PATIENT"],
  Notifications: ["PATIENT"],
  "Staff Alerts": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "PHARMACIST", "LAB_TECHNICIAN", "RADIOLOGIST", "BILLING_STAFF", "ACCOUNTANT", "HOUSEKEEPING"],
  "Check-In Desk": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "RECEPTIONIST"],
  Pharmacy: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "PHARMACIST"],
  Laboratory: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGIST"],
  "Billing & Payments": ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "BILLING_STAFF", "ACCOUNTANT"],
  Operations: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "LAB_TECHNICIAN", "RADIOLOGIST", "BILLING_STAFF", "ACCOUNTANT", "HOUSEKEEPING"],
  Intelligence: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "PHARMACIST", "LAB_TECHNICIAN", "RADIOLOGIST", "BILLING_STAFF", "ACCOUNTANT", "HOUSEKEEPING"],
  Security: ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "PHARMACIST", "LAB_TECHNICIAN", "RADIOLOGIST", "BILLING_STAFF", "ACCOUNTANT", "HOUSEKEEPING", "PATIENT"],
};
type Summary = { patients:number; appointments:number; occupiedBeds:number; availableBeds:number; doctorsOnDuty:number; pendingLabs:number; pendingInvoices?:number; revenue?:number };
const demoSummary: Summary = { patients: 30, appointments: 8, occupiedBeds: 4, availableBeds: 12, doctorsOnDuty: 3, pendingLabs: 7, pendingInvoices: 9, revenue: 23625 };
const demoRows: Record<string, { columns: string[]; rows: string[][] }> = {
  Patients: { columns: ["Patient ID", "Name", "Department", "Phone"], rows: [["DEMO-001", "Aarav Sharma", "Cardiology", "+91 90000 10000"], ["DEMO-002", "Aditi Rao", "Neurology", "+91 90000 10001"], ["DEMO-003", "Ananya Patel", "General Medicine", "+91 90000 10002"], ["DEMO-004", "Arjun Mehta", "Pediatrics", "+91 90000 10003"]] },
  "Doctors & Staff": { columns: ["Name", "Specialty", "Department", "Status"], rows: [["Dr. Demo 1", "Cardiology", "Cardiology", "On duty"], ["Dr. Demo 2", "Neurology", "Neurology", "On duty"], ["Dr. Demo 3", "General Medicine", "General Medicine", "On duty"]] },
  Appointments: { columns: ["Appointment", "Patient", "Doctor", "Status"], rows: [["DEMO-APT-001", "Aarav Sharma", "Dr. Demo 1", "Scheduled"], ["DEMO-APT-002", "Aditi Rao", "Dr. Demo 2", "Scheduled"], ["DEMO-APT-003", "Ananya Patel", "Dr. Demo 3", "Completed"]] },
  "Admissions & Discharges": { columns: ["Admission", "Patient", "Bed", "Status"], rows: [["DEMO-ADM-001", "Aarav Sharma", "Cardiology / D-1", "Active"], ["DEMO-ADM-002", "Aditi Rao", "Neurology / D-1", "Active"], ["DEMO-ADM-003", "Ananya Patel", "General Medicine / D-1", "Active"]] },
  Pharmacy: { columns: ["SKU", "Medicine", "Quantity", "Stock"], rows: [["DEMO-MED-001", "Paracetamol", "25", "In stock"], ["DEMO-MED-002", "Amoxicillin", "30", "In stock"], ["DEMO-MED-003", "Metformin", "40", "In stock"]] },
  Laboratory: { columns: ["Order", "Patient", "Test", "Status"], rows: [["DEMO-LAB-001", "Aarav Sharma", "Complete Blood Count", "Ordered"], ["DEMO-LAB-002", "Aditi Rao", "Lipid Profile", "Processing"], ["DEMO-LAB-003", "Ananya Patel", "Chest X-Ray", "Completed"]] },
  "Billing & Payments": { columns: ["Invoice", "Patient", "Total", "Status"], rows: [["DEMO-INV-001", "Aarav Sharma", "₹525.00", "Unpaid"], ["DEMO-INV-002", "Aditi Rao", "₹656.25", "Unpaid"], ["DEMO-INV-003", "Ananya Patel", "₹787.50", "Partial"]] },
};

type OperationsTwinSnapshot = {
  totalBeds: number;
  occupiedBeds: number;
  availableBeds: number;
  activeAdmissions: number;
  appointmentsToday: number;
  pendingLabs: number;
  activeQueue: number;
  openHousekeepingTasks: number;
  availableAmbulances: number;
  activeDispatches: number;
  occupancyPercent: number;
  updatedAt: string;
};

function OperationsTwin() {
  const query = useQuery<OperationsTwinSnapshot>({
    queryKey: ["operations", "twin"],
    queryFn: () => api.get("/operations/twin").then((response) => response.data.data),
    refetchInterval: 15_000,
  });
  if (query.isLoading && !query.data) return <section className="panel phase5-panel"><p className="muted">Loading live operational data…</p></section>;
  if (query.isError) return <section className="panel phase5-panel"><h2>Live operations unavailable</h2><p className="error" role="alert">The operational summary could not be refreshed. Check your connection and permissions.</p></section>;
  const snapshot = query.data;
  if (!snapshot) return null;
  const metrics: Array<[string, number]> = [
    ["Bed occupancy", snapshot.occupancyPercent],
    ["Beds available", snapshot.availableBeds],
    ["Active admissions", snapshot.activeAdmissions],
    ["Appointments today", snapshot.appointmentsToday],
    ["Pending lab orders", snapshot.pendingLabs],
    ["Patients in queue", snapshot.activeQueue],
    ["Open housekeeping tasks", snapshot.openHousekeepingTasks],
    ["Available ambulances", snapshot.availableAmbulances],
    ["Active dispatches", snapshot.activeDispatches],
  ];
  return <section className="panel phase5-panel"><div className="panel-title"><div><p className="eyebrow">DATABASE-BACKED OPERATIONS</p><h2>Live hospital activity</h2></div><span className="badge">REFRESHES EVERY 15 SECONDS</span></div><div className="ops-live-grid">{metrics.map(([label, value]) => <div className="ops-live-card" key={label}><small>{label}</small><strong>{label === "Bed occupancy" ? `${value}%` : value}</strong></div>)}</div><p className="ops-live-meta">Updated {new Date(snapshot.updatedAt).toLocaleTimeString()} · {snapshot.occupiedBeds} of {snapshot.totalBeds} beds occupied</p></section>;
}

type AuthUser = { id: string; name: string; email: string; role: string; mfaEnabled: boolean };
type Theme = "light" | "dark";

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const Icon = theme === "dark" ? Sun : Moon;
  const nextTheme = theme === "dark" ? "light" : "dark";
  return <button type="button" className="theme-toggle" aria-label={`Switch to ${nextTheme} theme`} aria-pressed={theme === "dark"} title={`Switch to ${nextTheme} theme`} onClick={onToggle}><Icon size={18}/><span className="sr-only">Switch to {nextTheme} theme</span></button>;
}

function SecurityPage({ user, onMfaChanged }: { user: AuthUser; onMfaChanged: (enabled: boolean) => void }) {
  const [password,setPassword]=React.useState("");
  const [code,setCode]=React.useState("");
  const [secret,setSecret]=React.useState("");
  const [recoveryCodes,setRecoveryCodes]=React.useState<string[]>([]);
  const [message,setMessage]=React.useState("");
  const [error,setError]=React.useState("");
  const [busy,setBusy]=React.useState(false);
  const handleError=(caught: unknown)=>setError(axios.isAxiosError(caught) ? caught.response?.data?.error?.message ?? "The security request failed." : "The security request failed.");
  const beginEnrollment=async (event: React.FormEvent)=>{
    event.preventDefault(); setError(""); setMessage(""); setBusy(true);
    try { const response=await api.post("/auth/mfa/enroll",{password}); setSecret(response.data.data.secret); setMessage("Add this key to your authenticator app, then verify a current code."); }
    catch(caught){handleError(caught);} finally{setBusy(false);}
  };
  const enableMfa=async (event: React.FormEvent)=>{
    event.preventDefault(); setError(""); setBusy(true);
    try { const response=await api.post("/auth/mfa/enable",{code}); setRecoveryCodes(response.data.data.recoveryCodes); setSecret(""); setCode(""); setPassword(""); setMessage("MFA is enabled. Save these recovery codes now; they will not be shown again."); onMfaChanged(true); }
    catch(caught){handleError(caught);} finally{setBusy(false);}
  };
  const disableMfa=async (event: React.FormEvent)=>{
    event.preventDefault(); setError(""); setBusy(true);
    try { await api.post("/auth/mfa/disable",{password,code}); setPassword(""); setCode(""); setRecoveryCodes([]); setMessage("MFA has been disabled."); onMfaChanged(false); }
    catch(caught){handleError(caught);} finally{setBusy(false);}
  };
  return <><p className="eyebrow">ACCOUNT SECURITY</p><div className="page-head"><div><h1>Security settings</h1><p className="muted">Manage multi-factor authentication for {user.email}.</p></div><span className="badge">{user.mfaEnabled ? "MFA ENABLED" : "MFA NOT ENABLED"}</span></div><section className="panel security-panel"><h2>Authenticator-based MFA</h2><p className="muted">Use a time-based authenticator code in addition to your password when signing in.</p>{message && <p role="status" className="security-message">{message}</p>}{error && <p role="alert" className="error">{error}</p>}{recoveryCodes.length>0 && <div className="recovery-codes"><strong>Recovery codes — keep them private</strong><div>{recoveryCodes.map(item=><code key={item}>{item}</code>)}</div></div>}{user.mfaEnabled ? <form onSubmit={disableMfa} className="security-form"><label>Password<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required/></label><label>Authenticator or recovery code<input inputMode="text" autoComplete="one-time-code" value={code} onChange={event=>setCode(event.target.value)} required/></label><button className="primary" disabled={busy}>{busy ? "Verifying…" : "Disable MFA"}</button></form> : <>{!secret ? <form onSubmit={beginEnrollment} className="security-form"><label>Confirm password<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required/></label><button className="primary" disabled={busy}>{busy ? "Starting…" : "Set up MFA"}</button></form> : <form onSubmit={enableMfa} className="security-form"><p>Authenticator setup key: <code>{secret}</code></p><label>6-digit verification code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event=>setCode(event.target.value)} required/></label><button className="primary" disabled={busy}>{busy ? "Verifying…" : "Enable MFA"}</button></form>}</>}</section></>;
}

function App({ initialUser, onLogout, theme, onToggleTheme }: { initialUser: AuthUser | null; onLogout: () => void; theme: Theme; onToggleTheme: () => void }) {
  const initialPage = initialUser?.role === "PATIENT" ? (new URLSearchParams(window.location.search).has("familyInvite") ? "Family Access" : "Patient Portal") : "Dashboard";
  const [page,setPage]=React.useState(initialPage);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [user,setUser]=React.useState<AuthUser|null>(initialUser);
  const [logoutError,setLogoutError]=React.useState("");
  const selectPage = (nextPage: string) => {
    setPage(nextPage);
    setSidebarOpen(false);
  };
  const visibleNav = nav.filter(item => pageRoles[item.label]?.includes(user?.role ?? ""));
  const visibleNavLabels = new Set(visibleNav.map((item) => item.label));
  React.useEffect(() => {
    if (!pageRoles[page]?.includes(user?.role ?? "")) setPage("Dashboard");
  }, [page, user?.role]);
  React.useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);
  const logout = async () => {
    setLogoutError("");
    try {
      await api.post("/auth/logout");
    } catch {
      setLogoutError("Could not confirm sign-out with the server. Please retry while connected.");
      return;
    }
    queryClient.clear();
    setUser(null);
    onLogout();
  };
  return <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    {sidebarOpen && <button type="button" className="mobile-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}/>}
    <aside className={`${sidebarOpen ? "sidebar-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`} aria-label="MediVerse navigation">
      <div className="sidebar-brand">
        <div className="logo"><span className="logo-mark" aria-hidden="true">✦</span><span className="logo-word">Medi<span>Verse</span></span></div>
      </div>
      <nav aria-label="Primary">
        {navGroups.map((group) => {
          const items = nav.filter((item) => group.items.includes(item.label) && visibleNavLabels.has(item.label));
          if (!items.length) return null;
          return <section className="nav-group" key={group.label}>
            <p className="nav-group-label">{group.label}</p>
            {items.map((item) => {
              const Icon = item.icon;
              return <button type="button" className={page === item.label ? "active" : ""} onClick={() => selectPage(item.label)} key={item.label} aria-label={item.label} aria-current={page === item.label ? "page" : undefined} title={sidebarCollapsed ? item.label : undefined}><Icon size={18}/><span className="nav-item-label">{item.label}</span></button>;
            })}
          </section>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <span className="sidebar-mode"><span className="status-dot" aria-hidden="true"/>{demoEnabled ? "Synthetic demo mode" : "Secure workspace"}</span>
        {logoutError && <p className="error" role="alert">{logoutError}</p>}
        {user && <button type="button" className="sidebar-signout" onClick={logout}><LogOut size={17}/><span>Sign out</span></button>}
      </div>
    </aside>
    <main className="main">
      <header className="app-header">
        <div className="header-leading">
          <button type="button" className="mobile-menu" aria-label={sidebarOpen ? "Close navigation" : "Open navigation"} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><Menu size={19}/></button>
          <button type="button" className="desktop-sidebar-toggle" aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</button>
          <div className="header-breadcrumb"><span>Workspace</span><ChevronRight size={15} aria-hidden="true"/><strong>{page}</strong></div>
        </div>
        <div className="header-trailing">
          <button type="button" className="global-search-trigger" aria-label="Open global search" onClick={() => { setCommandOpen(true); setCommandQuery(""); }}>
            <Search size={16}/>
            <span>Search MediVerse</span>
            <kbd>Ctrl K</kbd>
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
          <div className="profile-summary"><span className="profile-avatar" aria-hidden="true">{user?.name.slice(0, 1).toUpperCase() ?? "M"}</span><span><strong>{user?.name ?? "MediVerse"}</strong><small>{user?.role.replaceAll("_", " ") ?? "Workspace"}</small></span></div>
        </div>
      </header>
      {commandOpen && <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Navigate MediVerse">
          <div className="command-input-wrap">
            <Search size={18}/>
            <input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search pages and workflows…" aria-label="Search pages and workflows"/>
            <button type="button" aria-label="Close command palette" onClick={() => setCommandOpen(false)}><X size={16}/></button>
          </div>
          <div className="command-results">
            {visibleNav
              .filter((item) => item.label.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase()))
              .map((item) => {
                const Icon = item.icon;
                return <button type="button" key={item.label} onClick={() => { selectPage(item.label); setCommandOpen(false); setCommandQuery(""); }}>
                  <span className="command-icon"><Icon size={17}/></span>
                  <span><strong>{item.label}</strong><small>{navGroups.find((group) => group.items.includes(item.label))?.label ?? "Workspace"}</small></span>
                  <ChevronRight size={16}/>
                </button>;
              })}
            {visibleNav.every((item) => !item.label.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase())) && <p className="command-empty">No matching workspace pages</p>}
          </div>
        </section>
      </div>}
      <section className="content">{page === "Security" && user ? <SecurityPage user={user} onMfaChanged={(enabled) => setUser({ ...user, mfaEnabled: enabled })}/> : <Dashboard page={page} user={user} onNavigate={selectPage}/>}</section>
    </main>
  </div>;
}

type PatientRecord = { id: string; patientNumber: string; firstName: string; lastName: string; phone: string; department?: { name: string } | null };
type OperationalRecord = { id: string; patient?: { firstName: string; lastName: string; patientNumber: string }; status: string; testName?: string; startsAt?: string; bed?: { label: string; ward: { name: string } }; total?: string | number; balance?: string | number };
type RecordPageData = { items: Array<PatientRecord | OperationalRecord>; page: number; limit: number; total: number };
const moduleConfig: Record<string, { endpoint: string; title: string; statuses?: string[] }> = {
  Patients: { endpoint: "/patients", title: "patient records" },
  Appointments: { endpoint: "/appointments", title: "appointments", statuses: ["SCHEDULED", "CONFIRMED", "COMPLETED", "CANCELLED"] },
  "Admissions & Discharges": { endpoint: "/admissions", title: "admissions", statuses: ["ACTIVE", "DISCHARGED"] },
  Laboratory: { endpoint: "/lab-orders", title: "lab orders", statuses: ["ORDERED", "COLLECTED", "PROCESSING", "COMPLETED"] },
  "Billing & Payments": { endpoint: "/invoices", title: "invoices", statuses: ["UNPAID", "PARTIAL", "PAID"] },
};
function demoRecords(page: string): PatientRecord[] | OperationalRecord[] {
  const rows = demoRows[page]?.rows ?? [];
  if (page === "Patients") return rows.map((row, index) => ({ id: `demo-patient-${index}`, patientNumber: row[0], firstName: row[1].split(" ")[0], lastName: row[1].split(" ").slice(1).join(" "), phone: row[3], department: { name: row[2] } }));
  return rows.map((row, index) => ({
    id: `demo-${page.toLowerCase().replace(/\W/g, "-")}-${index}`,
    patient: { patientNumber: row[1], firstName: row[1].split(" ")[0], lastName: row[1].split(" ").slice(1).join(" ") },
    status: row[row.length - 1].toUpperCase(),
    testName: page === "Laboratory" ? row[2] : undefined,
    startsAt: page === "Appointments" ? new Date().toISOString() : undefined,
    total: page === "Billing & Payments" ? Number(row[2].replace(/[^\d.]/g, "")) : undefined,
  }));
}

function RecordsPage({ page }: { page: string }) {
  const config = moduleConfig[page];
  const [currentPage, setCurrentPage] = React.useState(1);
  const [filterText, setFilterText] = React.useState("");
  const queryKey = ["records", page, currentPage] as const;
  const query = useQuery<RecordPageData>({
    queryKey,
    queryFn: async () => {
      try {
        const response = await api.get(config.endpoint, { params: { page: currentPage, limit: 20 } });
        const payload = response.data.data;
        if (Array.isArray(payload)) return { items: payload, page: currentPage, limit: payload.length || 20, total: payload.length };
        return payload as RecordPageData;
      } catch {
        if (!demoEnabled) throw new Error("API unavailable");
        const items = demoRecords(page);
        return { items, page: 1, limit: 20, total: items.length };
      }
    },
  });
  const rows = query.data?.items ?? [];
  const normalizedFilter = filterText.trim().toLocaleLowerCase();
  const visibleRows = normalizedFilter ? rows.filter((row) => {
    const values = "patientNumber" in row
      ? [row.patientNumber, row.firstName, row.lastName, row.phone, row.department?.name]
      : [row.id, row.status, row.patient?.patientNumber, row.patient?.firstName, row.patient?.lastName, row.testName, row.bed?.ward.name, row.bed?.label, row.startsAt, row.total, row.balance];
    return values.some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedFilter));
  }) : rows;
  const isDemo = rows.length > 0 && rows.every(row => row.id.startsWith("demo-"));
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => isDemo
      ? Promise.resolve(queryClient.setQueryData(queryKey, (current: RecordPageData | undefined) => current ? { ...current, items: current.items.map(row => row.id === id ? { ...row, status } : row) } : current))
      : api.patch(`${config.endpoint}/${id}/status`, { status }),
    onSuccess: () => {
      if (!isDemo) {
        queryClient.invalidateQueries({ queryKey: ["records", page] });
        queryClient.invalidateQueries({ queryKey: ["summary"] });
      }
    },
  });
  const updatePatient = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Partial<PatientRecord> }) => isDemo
      ? Promise.resolve(queryClient.setQueryData(queryKey, (current: RecordPageData | undefined) => current ? { ...current, items: current.items.map(row => row.id === id ? { ...row, ...values } : row) } : current))
      : api.patch(`/patients/${id}`, values),
    onSuccess: () => {
      if (!isDemo) {
        queryClient.invalidateQueries({ queryKey: ["records", page] });
        queryClient.invalidateQueries({ queryKey: ["summary"] });
      }
    },
  });
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ firstName: "", lastName: "", phone: "" });
  if (query.isLoading) return <div className="empty">Loading {config.title}…</div>;
  if (query.isError) return <div className="empty"><h2>Unable to load records</h2><p className="muted">Sign in with an authorized hospital role and try again.</p></div>;
  const startEditing = (patient: PatientRecord) => {
    setEditingId(patient.id);
    setDraft({ firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone });
  };
  const savePatient = (id: string) => {
    updatePatient.mutate({ id, values: draft });
    setEditingId(null);
  };
  const actionError = updateStatus.error ?? updatePatient.error;
  return <><p className="eyebrow">{isDemo ? "DEMO RECORDS" : "LIVE RECORDS"}</p><div className="page-head"><div><h1>{page}</h1><p className="muted">{isDemo ? "The API is unavailable. Changes are saved in this demo view only." : "Update records directly and complete pending work from this view."}</p>{actionError && <p className="error" role="alert">Could not save this change. The API may be unavailable.</p>}</div></div><div className="panel data-panel"><div className="records-toolbar"><div className="panel-title"><h2>{query.data?.total ?? rows.length} {config.title}</h2><span className="badge">{isDemo ? "DEMO DATA" : "LIVE API"}</span></div><label className="record-search"><span>Search loaded records</span><input type="search" value={filterText} onChange={(event) => setFilterText(event.target.value)} aria-label="Search loaded records" placeholder="Name, ID, status…"/></label><small className="record-search-note">Search only filters records loaded on this page.</small></div>{rows.length === 0 ? <div className="empty">No records found.</div> : visibleRows.length === 0 ? <div className="empty">No loaded records match “{filterText}”.</div> : <div className="data-table">{page === "Patients" ? <div className="data-row data-header"><strong>Patient ID</strong><strong>Name</strong><strong>Department</strong><strong>Phone</strong><strong>Action</strong></div> : <div className="data-row data-header"><strong>Record</strong><strong>Patient</strong><strong>Details</strong><strong>Status</strong><strong>Action</strong></div>}{visibleRows.map((row) => { const patient = row as PatientRecord; const record = row as OperationalRecord; return <div className="data-row" key={row.id}>{page === "Patients" ? <>{editingId === patient.id ? <><input value={draft.firstName} onChange={event => setDraft({ ...draft, firstName: event.target.value })} aria-label="First name"/><input value={draft.lastName} onChange={event => setDraft({ ...draft, lastName: event.target.value })} aria-label="Last name"/></> : <><span>{patient.patientNumber}</span><span>{patient.firstName} {patient.lastName}</span></>}<span>{patient.department?.name ?? "Unassigned"}</span>{editingId === patient.id ? <input value={draft.phone} onChange={event => setDraft({ ...draft, phone: event.target.value })} aria-label="Phone"/> : <span>{patient.phone}</span>}<button className="table-action" onClick={() => editingId === patient.id ? savePatient(patient.id) : startEditing(patient)} aria-label={editingId === patient.id ? "Save patient" : "Edit patient"}>{editingId === patient.id ? <Save size={15}/> : <Edit3 size={15}/>}</button></> : <><span>{record.id.slice(0, 12)}</span><span>{record.patient ? `${record.patient.firstName} ${record.patient.lastName}` : "—"}</span><span>{record.testName ?? record.bed ? `${record.testName ?? ""}${record.bed ? `${record.testName ? " · " : ""}${record.bed.ward.name} / ${record.bed.label}` : ""}` : record.startsAt ? new Date(record.startsAt).toLocaleString() : record.total !== undefined ? `₹${Number(record.total).toLocaleString("en-IN")}` : "—"}</span><span className="status-text">{record.status}</span><select className="status-select" value={record.status} onChange={event => updateStatus.mutate({ id: record.id, status: event.target.value })} disabled={updateStatus.isPending}>{config.statuses?.map(status => <option key={status} value={status}>{status}</option>)}</select></>}</div>; })}</div>}{query.data && !isDemo && query.data.total > query.data.limit && <nav className="record-pagination" aria-label={`${config.title} pagination`}><button type="button" className="secondary" disabled={query.data.page <= 1} onClick={() => setCurrentPage((value) => value - 1)}>Previous</button><span>Page {query.data.page} · Showing {(query.data.page - 1) * query.data.limit + 1}–{Math.min(query.data.page * query.data.limit, query.data.total)} of {query.data.total}</span><button type="button" className="secondary" disabled={query.data.page * query.data.limit >= query.data.total} onClick={() => setCurrentPage((value) => value + 1)}>Next</button></nav>}</div></>;
}

function DemoPage({ page }: { page: string }) {
  const module = demoRows[page];
  if (!demoEnabled) return <section className="empty"><h2>{page} is not connected</h2><p className="muted">This module does not have a live API integration yet. Synthetic records are disabled outside development.</p></section>;
  return <><p className="eyebrow">SYNTHETIC DEMO RECORDS</p><div className="page-head"><div><h1>{page}</h1><p className="muted">Demo records are shown while the API is not connected.</p></div></div><div className="panel data-panel"><div className="panel-title"><h2>{module?.rows.length ?? 0} records</h2><span className="badge">DEMO DATA</span></div>{module && <div className="data-table"><div className="data-row data-header">{module.columns.map(column => <strong key={column}>{column}</strong>)}</div>{module.rows.map((row, index) => <div className="data-row" key={index}>{row.map((cell, cellIndex) => <span key={cellIndex}>{cell}</span>)}</div>)}</div>}</div></>;
}

function Dashboard({ page, user, onNavigate }: { page: string; user: AuthUser | null; onNavigate: (page: string) => void }) {
 const query=useQuery<Summary>({
  queryKey:["summary"],
  queryFn:()=>api.get("/dashboard/summary").then(r=>r.data.data).catch(error=>{
   if (!demoEnabled) throw error;
   return demoSummary;
  }),
  enabled: page === "Dashboard",
  refetchInterval:60000,
 });
 if (["Clinical Records", "Prescriptions", "Nursing", "Emergency"].includes(page) && user) return <ClinicalWorkspace page={page} api={api} user={user}/>;
 if (["Patient Portal", "Family Access", "Notifications", "Check-In Desk"].includes(page) && user) return <PortalWorkspace page={page} api={api} user={user}/>;
 if (page === "Admissions & Discharges" && user) return <DischargeWorkspace api={api} user={user}/>;
 if (page === "Staff Alerts" && user) return <StaffNotifications api={api}/>;
 if (page === "Intelligence" && user) return <React.Suspense fallback={<div className="empty">Loading intelligence workspace…</div>}><IntelligenceWorkspace api={api} userRole={user.role}/></React.Suspense>;
 if (["Operations", "Billing & Payments"].includes(page) && user) return <OperationsWorkspace page={page} api={api} user={user}/>;
 if(page!=="Dashboard") return moduleConfig[page] ? <RecordsPage page={page}/> : <DemoPage page={page}/>;
 if(query.isLoading && !query.data) return <div className="empty">Loading hospital data…</div>;
 if (query.isError) return <section className="empty"><h2>Unable to load hospital data</h2><p className="muted">The backend is unavailable. No demonstration data is displayed in this environment.</p></section>;
 const s=query.data ?? demoSummary;
 const isSyntheticDemo = demoEnabled && s === demoSummary;
 const cards: [string, number | string, LucideIcon][]=[["Registered patients",s.patients,Users],["Appointments today",s.appointments,CalendarDays],["Occupied beds",s.occupiedBeds,BedDouble],["Available beds",s.availableBeds,BedDouble],["Doctors on duty",s.doctorsOnDuty,Stethoscope],["Pending lab orders",s.pendingLabs,FlaskConical]];
 const financeRoles=["SUPER_ADMIN","HOSPITAL_ADMIN","ADMIN","BILLING_STAFF","ACCOUNTANT"];
 if (demoEnabled || (user && financeRoles.includes(user.role))) {
  cards.push(["Collected revenue",`₹${(s.revenue ?? 0).toLocaleString("en-IN")}`,WalletCards]);
 }
 const role = user?.role ?? "";
 const quickAction = ["Appointments", "Patients", "Admissions & Discharges", "Check-In Desk", "Operations", "Staff Alerts"].find((label) => pageRoles[label]?.includes(role));
 return <div className="dashboard-page">
   <div className="page-head dashboard-welcome">
     <div><p className="eyebrow">HOSPITAL OPERATIONS</p><h1>Welcome back, {user?.name ?? "Administrator"}</h1><p className="muted">A clear view of today’s hospital activity.</p></div>
     {quickAction && <button type="button" className="primary" onClick={() => onNavigate(quickAction)}>{quickAction === "Appointments" ? "View appointments" : quickAction === "Check-In Desk" ? "Open check-in desk" : `Open ${quickAction.toLowerCase()}`}</button>}
   </div>
   <div className="metrics">{cards.map(([label,value,Icon])=><div className="metric" key={String(label)}><Icon size={18}/><small>{label}</small><strong>{String(value)}</strong><span>{isSyntheticDemo ? "Synthetic demo data" : label === "Collected revenue" ? "Collected payments" : "Live from API"}</span></div>)}</div>
   <OperationsTwin/>
 </div>;
}

function LoginPage({ onAuthenticated, backendError, theme, onToggleTheme }: { onAuthenticated: (user: AuthUser) => void; backendError?: string; theme: Theme; onToggleTheme: () => void }) {
  const [registering,setRegistering]=React.useState(false);
  const [email,setEmail]=React.useState("");
  const [password,setPassword]=React.useState("");
  const [passwordVisible,setPasswordVisible]=React.useState(false);
  const [mfaCode,setMfaCode]=React.useState("");
  const [error,setError]=React.useState("");
  const [loading,setLoading]=React.useState(false);
  const [mfaUser,setMfaUser]=React.useState<AuthUser|null>(null);
  const handleSubmit=async (event: React.FormEvent)=>{
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response=await api.post("/auth/login",{email,password});
      if (response.data.data.mfaRequired) setMfaUser(response.data.data.user);
      else onAuthenticated(response.data.data.user);
    } catch (caught) {
      setError(axios.isAxiosError(caught) ? caught.response?.data?.error?.message ?? "Unable to sign in." : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  };
  const verifyMfa=async (event: React.FormEvent)=>{
    event.preventDefault(); setError(""); setLoading(true);
    try { await api.post("/auth/mfa/verify",{code:mfaCode}); onAuthenticated(mfaUser!); }
    catch(caught){setError(axios.isAxiosError(caught) ? caught.response?.data?.error?.message ?? "Unable to verify the code." : "Unable to verify the code.");}
    finally{setLoading(false);}
  };
  if (registering) return <><ThemeToggle theme={theme} onToggle={onToggleTheme}/><PatientPortalRegistration api={api} onBack={() => setRegistering(false)} onAuthenticated={onAuthenticated}/></>;
  return <main className="login-page">
    <ThemeToggle theme={theme} onToggle={onToggleTheme}/>
    <section className="login-card">
      <div className="login-brand"><span className="logo-mark" aria-hidden="true">✦</span><span>Medi<span>Verse</span></span></div>
      <p className="eyebrow">{demoEnabled ? "DEMONSTRATION ENVIRONMENT" : "SECURE WORKSPACE"}</p>
      <h1>{mfaUser ? "Verify your identity" : "Welcome to MediVerse"}</h1>
      <p className="muted">{mfaUser ? "Enter the code from your authenticator app, or use a recovery code." : "Sign in to your secure hospital workspace."}</p>
      {backendError && <p className="error login-notice" role="alert">{backendError}</p>}
      {mfaUser
        ? <form onSubmit={verifyMfa}>
            <label>Authenticator or recovery code<input value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} autoComplete="one-time-code" autoFocus required/></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={loading}>{loading ? "Verifying…" : "Verify and continue"}</button>
            <button type="button" className="secondary" onClick={() => { setMfaUser(null); setPassword(""); setMfaCode(""); setError(""); }}>Back to sign in</button>
          </form>
        : <form onSubmit={handleSubmit}>
            <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoCapitalize="none" required/></label>
            <label>Password<span className="password-input-wrap"><input type={passwordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required minLength={8}/><button type="button" className="password-visibility" aria-label={passwordVisible ? "Hide password" : "Show password"} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
            {demoEnabled && <button type="button" className="secondary demo-signin" onClick={() => onAuthenticated({ id: "demo", name: "Demo Administrator", email: "demo@mediverse.test", role: "ADMIN", mfaEnabled: false })}>Continue in demo mode</button>}
          </form>}
      {!mfaUser && <button type="button" className="secondary portal-register" onClick={() => setRegistering(true)}>Create patient portal account</button>}
      <p className="login-footnote"><ShieldCheck size={15}/> Authorized access only · Patient information is protected</p>
    </section>
  </main>;
}

function Root() {
  const [theme,setTheme]=React.useState<Theme>(() => window.localStorage.getItem("mediverse-theme") === "dark" ? "dark" : "light");
  const [user,setUser]=React.useState<AuthUser|null>(null);
  const [checking,setChecking]=React.useState(true);
  const [backendError,setBackendError]=React.useState("");
  const [invitationDismissed,setInvitationDismissed]=React.useState(false);
  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const familyInvite=new URLSearchParams(window.location.search).get("familyInvite") ?? "";
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("mediverse-theme", theme);
  }, [theme]);
  React.useEffect(()=>{
    const expireSession=()=>{setUser(null);queryClient.clear();};
    window.addEventListener("mediverse:session-expired",expireSession);
    api.get("/auth/me").then(response=>setUser(response.data.data.user)).catch(caught=>{
      setUser(null);
      if (axios.isAxiosError(caught) && caught.response?.status !== 401) {
        setBackendError("Unable to reach the MediVerse API. Sign-in requires a working backend.");
      }
    }).finally(()=>setChecking(false));
    return ()=>window.removeEventListener("mediverse:session-expired",expireSession);
  },[]);
  if(checking) return <div className="loading">Checking secure session…</div>;
  if(!user && familyInvite && !invitationDismissed) return <><ThemeToggle theme={theme} onToggle={toggleTheme}/><PatientFamilyInvitation api={api} token={familyInvite} onAuthenticated={setUser} onBack={()=>{window.history.replaceState({}, "", window.location.pathname);setInvitationDismissed(true);}}/></>;
  if(!user) return <LoginPage onAuthenticated={setUser} backendError={backendError} theme={theme} onToggleTheme={toggleTheme}/>;
  return <App initialUser={user} onLogout={()=>setUser(null)} theme={theme} onToggleTheme={toggleTheme}/>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Root/></QueryClientProvider>);

import React from "react";
import type { AxiosInstance } from "axios";
import { QRCodeSVG } from "qrcode.react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type PortalApi = Pick<AxiosInstance, "get" | "post" | "patch">;
type PortalUser = { id: string; email: string; name: string; role: string; mfaEnabled: boolean };
type PortalPatient = { id: string; patientNumber: string; firstName: string; lastName: string };
type PortalAccess = { patient: PortalPatient; scopes: string[]; expiresAt: string | null; isSelf: boolean };
type PortalAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  doctor: { id: string; specialty: string; user: { name: string } };
  department: { id: string; name: string };
  queueEntry?: { id: string; sequence: number; status: string; serviceDate: string } | null;
};
type NotificationPreferences = { inAppEnabled: boolean; emailEnabled: boolean };
type PortalAccount = { email: string; emailVerified: boolean; hasPatientProfile: boolean };
const scopes = ["APPOINTMENTS", "JOURNEY", "LAB_RESULTS", "BILLING"];
const nextQueueStatuses: Record<string, string[]> = {
  WAITING: ["CALLED", "CANCELLED"],
  CALLED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
const formatDate = (value: string) => new Date(value).toLocaleString();
const patientLabel = (patient: PortalPatient) => `${patient.patientNumber} · ${patient.firstName} ${patient.lastName}`;

function messageFrom(error: unknown) {
  if (typeof error === "object" && error !== null && "response" in error) {
    return String((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? "The request failed.");
  }
  return "The request failed.";
}

function PatientRegistration({ api, onBack, onAuthenticated }: { api: PortalApi; onBack: () => void; onAuthenticated: (user: PortalUser) => void }) {
  const [patientNumber, setPatientNumber] = React.useState("");
  const [dateOfBirth, setDateOfBirth] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [challengeId, setChallengeId] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const begin = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await api.post("/portal/register", { patientNumber, dateOfBirth, email, password });
      setChallengeId(response.data.data.challengeId);
      setMessage(response.data.data.message);
    } catch (caught) { setError(messageFrom(caught)); }
    finally { setBusy(false); }
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api.post("/portal/register/verify", { challengeId, code });
      const response = await api.post("/auth/login", { email, password });
      onAuthenticated(response.data.data.user);
    } catch (caught) { setError(messageFrom(caught)); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><section className="login-card"><div className="logo">✦ <span>Medi<span>Verse</span></span></div><p className="eyebrow">PATIENT PORTAL</p><h1>Create portal access</h1><p className="muted">Registration verifies details already held by the hospital. A verification code is sent to your email.</p>
    {message && <p role="status" className="security-message">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!challengeId ? <form onSubmit={begin}>
      <label>Patient number<input value={patientNumber} onChange={(event) => setPatientNumber(event.target.value)} required maxLength={40}/></label>
      <label>Date of birth<input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required/></label>
      <label>Email for sign-in and portal updates<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254}/></label>
      <label>Password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={72}/></label>
      <button className="primary" disabled={busy}>{busy ? "Requesting…" : "Send verification code"}</button>
      <button type="button" className="secondary" onClick={onBack}>Back to sign in</button>
    </form> : <form onSubmit={verify}>
      <label>Email verification code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required/></label>
      <button className="primary" disabled={busy}>{busy ? "Verifying…" : "Verify and sign in"}</button>
      <button type="button" className="secondary" onClick={() => { setChallengeId(""); setCode(""); setMessage(""); }}>Start again</button>
    </form>}
  </section></main>;
}

function FamilyInvitationAcceptance({ api, token, onAuthenticated, onBack }: { api: PortalApi; token: string; onAuthenticated: (user: PortalUser) => void; onBack: () => void }) {
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [mfaCode, setMfaCode] = React.useState("");
  const [pendingMfa, setPendingMfa] = React.useState<PortalUser | null>(null);
  const [existingAccount, setExistingAccount] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const preview = useQuery<{ scopes: string[]; expiresAt: string }>({
    queryKey: ["family-invitation-preview", token],
    queryFn: () => api.get(`/portal/family/invitations/preview?token=${encodeURIComponent(token)}`).then((response) => response.data.data),
    enabled: Boolean(token),
  });
  const register = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api.post("/portal/family/invitations/register", { token, name, password });
      window.history.replaceState({}, "", window.location.pathname);
      const signedIn = await api.post("/auth/login", { email: result.data.data.user.email, password });
      onAuthenticated(signedIn.data.data.user);
    } catch (caught) { setError(messageFrom(caught)); }
    finally { setBusy(false); }
  };
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api.post("/auth/login", { email, password: loginPassword });
      if (result.data.data.mfaRequired) setPendingMfa(result.data.data.user);
      else onAuthenticated(result.data.data.user);
    } catch (caught) { setError(messageFrom(caught)); }
    finally { setBusy(false); }
  };
  const verifyMfa = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api.post("/auth/mfa/verify", { code: mfaCode }); if (pendingMfa) onAuthenticated(pendingMfa); }
    catch (caught) { setError(messageFrom(caught)); }
    finally { setBusy(false); }
  };
  return <main className="login-page"><section className="login-card"><div className="logo">✦ <span>Medi<span>Verse</span></span></div><p className="eyebrow">FAMILY ACCESS</p><h1>Review invitation</h1>
    {preview.isLoading && <p className="muted">Loading invitation details…</p>}
    {preview.isError && <p role="alert" className="error">{messageFrom(preview.error)}</p>}
    {preview.data && <><p className="muted">The patient has authorized these sections: {preview.data.scopes.map((scope) => scope.replaceAll("_", " ").toLowerCase()).join(", ")}. Access expires {formatDate(preview.data.expiresAt)}.</p>{error && <p role="alert" className="error">{error}</p>}
      {pendingMfa ? <form onSubmit={verifyMfa}><label>Authenticator or recovery code<input value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} autoComplete="one-time-code" required/></label><button className="primary" disabled={busy}>Verify and continue</button></form>
        : existingAccount ? <form onSubmit={signIn}><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required/></label><label>Password<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required/></label><button className="primary" disabled={busy}>Sign in to accept</button><button type="button" className="secondary" onClick={() => setExistingAccount(false)}>Create a new account</button></form>
          : <form onSubmit={register}><label>Your name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120}/></label><label>Create password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={72}/></label><button className="primary" disabled={busy}>{busy ? "Accepting…" : "Create account and accept"}</button><button type="button" className="secondary" onClick={() => setExistingAccount(true)}>I already have an account</button></form>}
    </>}
    <button className="secondary" onClick={onBack}>Back to sign in</button>
  </section></main>;
}

function PatientPortalPage({ api, user }: { api: PortalApi; user: PortalUser }) {
  const client = useQueryClient();
  const patients = useQuery<PortalAccess[]>({ queryKey: ["portal-patients"], queryFn: () => api.get("/portal/patients").then((response) => response.data.data) });
  const [patientId, setPatientId] = React.useState("");
  const [doctorId, setDoctorId] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [endsAt, setEndsAt] = React.useState("");
  const [qr, setQr] = React.useState<{ appointmentId: string; token: string; expiresAt: string } | null>(null);
  React.useEffect(() => {
    if (!patientId && patients.data?.length === 1) setPatientId(patients.data[0].patient.id);
  }, [patientId, patients.data]);
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["portal-appointments", patientId] });
    void client.invalidateQueries({ queryKey: ["portal-journey", patientId] });
    void client.invalidateQueries({ queryKey: ["portal-queue", patientId] });
  };
  const doctors = useQuery<Array<{ id: string; specialty: string; user: { name: string }; department: { id: string; name: string } }>>({
    queryKey: ["portal-doctors", patientId],
    queryFn: () => api.get(`/portal/doctors?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const appointments = useQuery<PortalAppointment[]>({
    queryKey: ["portal-appointments", patientId],
    queryFn: () => api.get(`/portal/appointments?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const journey = useQuery<Array<{ id: string; occurredAt: string; type: string; label: string; status: string }>>({
    queryKey: ["portal-journey", patientId],
    queryFn: () => api.get(`/portal/journey?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const labResults = useQuery<Array<{ id: string; testName: string; status: string; updatedAt: string; result?: { summary: string; createdAt: string } | null }>>({
    queryKey: ["portal-lab-results", patientId],
    queryFn: () => api.get(`/portal/lab-results?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const invoices = useQuery<Array<{ id: string; total: string; balance: string; status: string; createdAt: string }>>({
    queryKey: ["portal-billing", patientId],
    queryFn: () => api.get(`/portal/billing?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const queue = useQuery<Array<{ id: string; sequence: number; serviceDate: string; checkedInAt: string; status: string; department: { name: string } }>>({
    queryKey: ["portal-queue", patientId],
    queryFn: () => api.get(`/portal/queue?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const book = useMutation({
    mutationFn: () => api.post("/portal/appointments", { patientId, doctorId, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }),
    onSuccess: () => { setStartsAt(""); setEndsAt(""); invalidate(); },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.patch(`/portal/appointments/${id}/cancel`, { patientId }),
    onSuccess: invalidate,
  });
  const createQr = useMutation({
    mutationFn: (id: string) => api.post(`/portal/appointments/${id}/check-in-token`, { patientId }),
    onSuccess: (response, appointmentId) => setQr({ appointmentId, token: response.data.data.token, expiresAt: response.data.data.expiresAt }),
  });
  const patient = patients.data?.find((item) => item.patient.id === patientId);
  return <><p className="eyebrow">PATIENT EXPERIENCE</p><div className="page-head"><div><h1>My care</h1><p className="muted">Appointments, journey updates, results, and queue information for you or a patient who shared access.</p></div></div>
    {patients.isError && <p className="error" role="alert">{messageFrom(patients.error)}</p>}
    {!patients.isLoading && !patients.data?.length && <section className="panel phase2-panel"><h2>No patient access is linked to this account</h2><p className="muted">Patient accounts are linked after email verification. Family access appears here after an invitation is accepted.</p></section>}
    {patients.data && patients.data.length > 0 && <section className="panel phase2-panel"><label>Patient<select value={patientId} onChange={(event) => { setPatientId(event.target.value); setQr(null); }}><option value="">Select a patient</option>{patients.data.map((entry) => <option key={entry.patient.id} value={entry.patient.id}>{patientLabel(entry.patient)}{entry.isSelf ? " · You" : " · Shared access"}</option>)}</select></label>
      {patient && !patient.isSelf && <small className="muted">Delegated access: {patient.scopes.map((scope) => scope.replaceAll("_", " ").toLowerCase()).join(", ")} · expires {patient.expiresAt ? formatDate(patient.expiresAt) : "—"}</small>}
    </section>}
    {patientId && <div className="portal-grid">
      {patient?.scopes.includes("APPOINTMENTS") && <section className="panel phase2-panel"><h2>Appointments</h2>
        <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); book.mutate(); }}>
          <label>Clinician<select value={doctorId} onChange={(event) => setDoctorId(event.target.value)} required><option value="">Select a clinician</option>{(doctors.data ?? []).map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.user.name} · {doctor.specialty} · {doctor.department.name}</option>)}</select></label>
          <label>Starts at<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required/></label>
          <label>Ends at<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required/></label>
          <button className="primary" disabled={book.isPending || !doctorId}>{book.isPending ? "Booking…" : "Request appointment"}</button>
        </form>
        {book.error && <p role="alert" className="error">{messageFrom(book.error)}</p>}
        {appointments.isError && <p role="alert" className="error">{messageFrom(appointments.error)}</p>}
        <div className="portal-list">{(appointments.data ?? []).map((appointment) => {
          const canCheckIn = ["SCHEDULED", "CONFIRMED"].includes(appointment.status) && Date.now() >= new Date(appointment.startsAt).getTime() - 24 * 60 * 60 * 1000 && Date.now() < new Date(appointment.endsAt).getTime() && !appointment.queueEntry;
          return <article className="clinical-record" key={appointment.id}><div className="clinical-record-head"><div><strong>{appointment.doctor.user.name} · {appointment.department.name}</strong><small>{formatDate(appointment.startsAt)} · {appointment.status}</small></div><span className="badge">{appointment.status}</span></div>
            <div className="clinical-actions">{["SCHEDULED", "CONFIRMED"].includes(appointment.status) && new Date(appointment.startsAt) > new Date() && <button className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(appointment.id)}>Cancel appointment</button>}
              {canCheckIn && <button className="secondary" disabled={createQr.isPending} onClick={() => createQr.mutate(appointment.id)}>Create check-in QR</button>}
              {appointment.queueEntry && <span className="badge">Queue {appointment.queueEntry.sequence} · {appointment.queueEntry.status}</span>}
            </div>
            {qr?.appointmentId === appointment.id && new Date(qr.expiresAt) > new Date() && <div className="qr-card"><QRCodeSVG value={qr.token} size={180} level="M"/><span>Show this one-use code at reception. Expires {formatDate(qr.expiresAt)}.</span></div>}
          </article>;
        })}</div>
        {(cancel.error || createQr.error) && <p role="alert" className="error">{messageFrom(cancel.error ?? createQr.error)}</p>}
      </section>}
      {patient?.scopes.includes("APPOINTMENTS") && <section className="panel phase2-panel"><h2>Queue status</h2>{queue.isError && <p role="alert" className="error">{messageFrom(queue.error)}</p>}<div className="portal-list">{(queue.data ?? []).map((entry) => <div className="clinical-row" key={entry.id}><span><strong>{entry.department.name} · token {entry.sequence}</strong><small>{formatDate(entry.checkedInAt)}</small></span><span className="badge">{entry.status}</span></div>)}</div>{!queue.isLoading && !queue.data?.length && <p className="muted">No check-ins yet.</p>}</section>}
      {patient?.scopes.includes("JOURNEY") && <section className="panel phase2-panel"><h2>Care journey</h2>{journey.isError && <p role="alert" className="error">{messageFrom(journey.error)}</p>}<div className="portal-list">{(journey.data ?? []).map((event) => <div className="clinical-row" key={`${event.type}-${event.id}`}><span><strong>{event.label}</strong><small>{formatDate(event.occurredAt)}</small></span><span className="badge">{event.status}</span></div>)}</div>{!journey.isLoading && !journey.data?.length && <p className="muted">No journey events are available.</p>}</section>}
      {patient?.scopes.includes("LAB_RESULTS") && <section className="panel phase2-panel"><h2>Laboratory results</h2>{labResults.isError && <p role="alert" className="error">{messageFrom(labResults.error)}</p>}<div className="portal-list">{(labResults.data ?? []).map((result) => <div className="clinical-row" key={result.id}><span><strong>{result.testName}</strong><small>{result.result?.summary ?? "No result summary is available."}</small></span><span className="badge">{result.status}</span></div>)}</div>{!labResults.isLoading && !labResults.data?.length && <p className="muted">No completed results are available.</p>}</section>}
      {patient?.scopes.includes("BILLING") && <section className="panel phase2-panel"><h2>Billing</h2>{invoices.isError && <p role="alert" className="error">{messageFrom(invoices.error)}</p>}<div className="portal-list">{(invoices.data ?? []).map((invoice) => <div className="clinical-row" key={invoice.id}><span><strong>Invoice · {formatDate(invoice.createdAt)}</strong><small>Balance {Number(invoice.balance).toLocaleString()}</small></span><span className="badge">{invoice.status}</span></div>)}</div>{!invoices.isLoading && !invoices.data?.length && <p className="muted">No invoices are available.</p>}</section>}
    </div>}
  </>;
}

function FamilyAccessPage({ api, account }: { api: PortalApi; account: PortalAccount | undefined }) {
  const client = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>(["APPOINTMENTS", "JOURNEY"]);
  const [expiresInDays, setExpiresInDays] = React.useState(7);
  const invitationToken = new URLSearchParams(window.location.search).get("familyInvite") ?? "";
  const access = useQuery({
    queryKey: ["family-access"],
    queryFn: () => api.get("/portal/family/access").then((response) => response.data.data as { grants: Array<{ id: string; scopes: string[]; expiresAt: string; revokedAt: string | null; grantee: { name: string; email: string } }>; invitations: Array<{ id: string; invitedEmail: string; scopes: string[]; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }> }),
    enabled: Boolean(account?.hasPatientProfile),
  });
  const received = useQuery({
    queryKey: ["family-grants"],
    queryFn: () => api.get("/portal/family/grants").then((response) => response.data.data as Array<{ id: string; scopes: string[]; expiresAt: string; patient: PortalPatient }>),
    enabled: !account?.hasPatientProfile,
  });
  const invitePreview = useQuery<{ scopes: string[]; expiresAt: string }>({
    queryKey: ["family-invitation-preview", invitationToken],
    queryFn: () => api.get(`/portal/family/invitations/preview?token=${encodeURIComponent(invitationToken)}`).then((response) => response.data.data),
    enabled: Boolean(invitationToken),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["family-access"] });
    void client.invalidateQueries({ queryKey: ["family-grants"] });
  };
  const invite = useMutation({
    mutationFn: () => api.post("/portal/family/invitations", { email, scopes: selectedScopes, expiresInDays }),
    onSuccess: () => { setEmail(""); refresh(); },
  });
  const accept = useMutation({
    mutationFn: () => api.post("/portal/family/invitations/accept", { token: invitationToken }),
    onSuccess: () => { window.history.replaceState({}, "", window.location.pathname); refresh(); },
  });
  const revokeGrant = useMutation({ mutationFn: (id: string) => api.patch(`/portal/family/grants/${id}/revoke`, {}), onSuccess: refresh });
  const revokeInvite = useMutation({ mutationFn: (id: string) => api.patch(`/portal/family/invitations/${id}/revoke`, {}), onSuccess: refresh });
  const errors = invite.error ?? accept.error ?? revokeGrant.error ?? revokeInvite.error ?? access.error ?? received.error ?? invitePreview.error;
  return <><p className="eyebrow">SHARED ACCESS</p><div className="page-head"><div><h1>Family access</h1><p className="muted">Patients control exactly which portal sections are shared and can revoke access at any time.</p></div></div>
    {invitationToken && <section className="panel phase2-panel"><h2>Invitation details</h2>{invitePreview.isLoading && <p className="muted">Loading invitation…</p>}{invitePreview.data && <><p className="muted">Shared sections: {invitePreview.data.scopes.join(", ")} · expires {formatDate(invitePreview.data.expiresAt)}.</p><button className="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>Accept family access</button></>}{invitePreview.isError && <p className="error" role="alert">{messageFrom(invitePreview.error)}</p>}</section>}
    {account?.hasPatientProfile ? <>
      <section className="panel phase2-panel"><h2>Invite a family member</h2><p className="muted">An email invitation is sent without patient details. The recipient must accept the invitation and use the invited email address.</p>
        <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
          <label>Family member email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254}/></label>
          <label>Access duration (days)<input type="number" min="1" max="30" value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} required/></label>
          <fieldset className="portal-scopes"><legend>Sections to share</legend>{scopes.map((scope) => <label className="clinical-checkbox" key={scope}><input type="checkbox" checked={selectedScopes.includes(scope)} onChange={(event) => setSelectedScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))}/>{scope.replaceAll("_", " ")}</label>)}</fieldset>
          <button className="primary" disabled={invite.isPending || selectedScopes.length === 0 || !account.emailVerified}>{invite.isPending ? "Sending…" : "Send invitation"}</button>
        </form>
        {!account.emailVerified && <p className="muted">Verify your email in Notifications before inviting family members.</p>}
      </section>
      <section className="panel phase2-panel"><h2>Family grants</h2>{access.isLoading && <p className="muted">Loading access…</p>}<div className="portal-list">{access.data?.grants.map((grant) => <div className="clinical-row" key={grant.id}><span><strong>{grant.grantee.name} · {grant.grantee.email}</strong><small>{grant.scopes.join(", ")} · expires {formatDate(grant.expiresAt)}{grant.revokedAt ? " · revoked" : ""}</small></span>{!grant.revokedAt && new Date(grant.expiresAt) > new Date() && <button className="secondary" disabled={revokeGrant.isPending} onClick={() => revokeGrant.mutate(grant.id)}>Revoke</button>}</div>)}</div>
        <h3>Invitations</h3><div className="portal-list">{access.data?.invitations.map((item) => <div className="clinical-row" key={item.id}><span><strong>{item.invitedEmail}</strong><small>{item.scopes.join(", ")} · expires {formatDate(item.expiresAt)}{item.acceptedAt ? " · accepted" : ""}{item.revokedAt ? " · revoked" : ""}</small></span>{!item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > new Date() && <button className="secondary" disabled={revokeInvite.isPending} onClick={() => revokeInvite.mutate(item.id)}>Revoke</button>}</div>)}</div>
      </section>
    </> : <section className="panel phase2-panel"><h2>Access shared with you</h2>{received.isLoading && <p className="muted">Loading shared access…</p>}<div className="portal-list">{received.data?.map((grant) => <div className="clinical-row" key={grant.id}><span><strong>{patientLabel(grant.patient)}</strong><small>{grant.scopes.join(", ")} · expires {formatDate(grant.expiresAt)}</small></span></div>)}</div>{received.isError && <p className="error" role="alert">{messageFrom(received.error)}</p>}</section>}
    {errors && <p className="error" role="alert">{messageFrom(errors)}</p>}
  </>;
}

function NotificationsPage({ api, account }: { api: PortalApi; account: PortalAccount | undefined }) {
  const client = useQueryClient();
  const preference = useQuery<NotificationPreferences>({
    queryKey: ["portal-notification-preferences"],
    queryFn: () => api.get("/portal/notification-preferences").then((response) => response.data.data),
  });
  const notifications = useQuery<{ items: Array<{ id: string; title: string; message: string; category: string; readAt: string | null; createdAt: string; deliveries: Array<{ channel: string; status: string; attempts: number; lastError?: string | null }> }>; preference: NotificationPreferences }>({
    queryKey: ["portal-notifications"],
    queryFn: () => api.get("/portal/notifications").then((response) => response.data.data),
  });
  const [draft, setDraft] = React.useState<NotificationPreferences | null>(null);
  React.useEffect(() => { if (preference.data) setDraft(preference.data); }, [preference.data]);
  const [verificationCode, setVerificationCode] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const update = useMutation({
    mutationFn: () => api.patch("/portal/notification-preferences", draft),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["portal-notification-preferences"] }); void client.invalidateQueries({ queryKey: ["portal-notifications"] }); },
  });
  const read = useMutation({
    mutationFn: (id: string) => api.patch(`/portal/notifications/${id}/read`, {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["portal-notifications"] }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/portal/notifications/${id}/retry`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["portal-notifications"] }),
  });
  const requestEmailCode = async () => {
    setError(""); setMessage("");
    try { await api.post("/portal/email/verification"); setMessage("A verification code was sent to your account email."); }
    catch (caught) { setError(messageFrom(caught)); }
  };
  const confirmEmail = async (event: React.FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    try { await api.post("/portal/email/verification/confirm", { code: verificationCode }); setVerificationCode(""); setMessage("Email verified."); void client.invalidateQueries({ queryKey: ["portal-account"] }); }
    catch (caught) { setError(messageFrom(caught)); }
  };
  return <><p className="eyebrow">PORTAL UPDATES</p><div className="page-head"><div><h1>Notifications</h1><p className="muted">External messages contain generic reminders only. Sign in to view appointment or queue details.</p></div></div>
    {account && <section className="panel phase2-panel"><h2>Verified email</h2><p className="muted">{account.email}: {account.emailVerified ? "verified" : "not verified"}</p>{!account.emailVerified && <><button className="secondary" onClick={requestEmailCode}>Send email verification code</button><form className="clinical-actions" onSubmit={confirmEmail}><label>Verification code<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} required/></label><button className="secondary">Verify email</button></form></>}</section>}
    {draft && <section className="panel phase2-panel"><h2>Delivery preferences</h2><form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
      <label className="clinical-checkbox"><input type="checkbox" checked={draft.inAppEnabled} onChange={(event) => setDraft({ ...draft, inAppEnabled: event.target.checked })}/>In-app notifications</label>
      <label className="clinical-checkbox"><input type="checkbox" checked={draft.emailEnabled} disabled={!account?.hasPatientProfile || !account.emailVerified} onChange={(event) => setDraft({ ...draft, emailEnabled: event.target.checked })}/>Email notifications</label>
      <button className="primary" disabled={update.isPending}>{update.isPending ? "Saving…" : "Save preferences"}</button>
    </form></section>}
    <section className="panel phase2-panel"><h2>Recent notifications</h2>{notifications.isLoading && <p className="muted">Loading notifications…</p>}{notifications.isError && <p role="alert" className="error">{messageFrom(notifications.error)}</p>}<div className="portal-list">{notifications.data?.items.map((item) => <article className="clinical-record" key={item.id}><div className="clinical-record-head"><div><strong>{item.title}</strong><small>{formatDate(item.createdAt)} · {item.category}</small></div>{!item.readAt && <button className="secondary" disabled={read.isPending} onClick={() => read.mutate(item.id)}>Mark read</button>}</div><p>{item.message}</p>{item.deliveries.map((delivery) => <div key={delivery.channel}><small>{delivery.channel}: {delivery.status}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</small>{delivery.status === "FAILED" && delivery.attempts < 3 && <button className="secondary" disabled={retry.isPending} onClick={() => retry.mutate(item.id)}>Retry delivery</button>}</div>)}</article>)}</div>{notifications.data?.preference && !notifications.data.preference.inAppEnabled && <p className="muted">In-app notifications are disabled in your preferences.</p>}</section>
    {(error || update.error || read.error || retry.error) && <p role="alert" className="error">{error || messageFrom(update.error ?? read.error ?? retry.error)}</p>}{message && <p role="status" className="security-message">{message}</p>}
  </>;
}

function CheckInDesk({ api }: { api: PortalApi }) {
  const client = useQueryClient();
  const departments = useQuery<Array<{ id: string; name: string }>>({ queryKey: ["portal-departments"], queryFn: () => api.get("/portal/departments").then((response) => response.data.data) });
  const [departmentId, setDepartmentId] = React.useState("");
  const [token, setToken] = React.useState("");
  const [checkInResult, setCheckInResult] = React.useState<{ patient: PortalPatient; department: { name: string }; entry: { sequence: number; status: string } } | null>(null);
  const queue = useQuery<Array<{ id: string; sequence: number; status: string; patient: PortalPatient; appointment?: { startsAt: string; doctor: { user: { name: string } } } | null }>>({
    queryKey: ["portal-queue-desk", departmentId],
    queryFn: () => api.get(`/portal/queue/desk?departmentId=${encodeURIComponent(departmentId)}`).then((response) => response.data.data),
    enabled: Boolean(departmentId),
    refetchInterval: 15000,
  });
  const checkIn = useMutation({
    mutationFn: () => api.post("/portal/check-in/redeem", { token: token.trim() }),
    onSuccess: (response) => { setCheckInResult(response.data.data); setToken(""); void client.invalidateQueries({ queryKey: ["portal-queue-desk", departmentId] }); },
  });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/portal/queue/desk/${id}`, { status }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["portal-queue-desk", departmentId] }),
  });
  return <><p className="eyebrow">RECEPTION</p><div className="page-head"><div><h1>Check-in desk</h1><p className="muted">Scan the patient's short-lived QR token with a keyboard-wedge scanner, then manage today's queue.</p></div></div>
    <section className="panel phase2-panel"><label>Department<select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">Select a department</option>{(departments.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <form className="clinical-actions" onSubmit={(event) => { event.preventDefault(); checkIn.mutate(); }}><label>Scan QR token<input autoFocus autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required minLength={40} maxLength={100}/></label><button className="primary" disabled={checkIn.isPending || !token.trim()}>{checkIn.isPending ? "Checking in…" : "Complete check-in"}</button></form>
      {checkInResult && <p role="status" className="security-message">Checked in {patientLabel(checkInResult.patient)} · {checkInResult.department.name} · queue token {checkInResult.entry.sequence}.</p>}
      {checkIn.error && <p role="alert" className="error">{messageFrom(checkIn.error)}</p>}
    </section>
    <section className="panel phase2-panel"><h2>Today's queue</h2>{queue.isError && <p role="alert" className="error">{messageFrom(queue.error)}</p>}<div className="portal-list">{(queue.data ?? []).map((entry) => <div className="clinical-row" key={entry.id}><span><strong>Token {entry.sequence} · {patientLabel(entry.patient)}</strong><small>{entry.appointment ? `${entry.appointment.doctor.user.name} · ${formatDate(entry.appointment.startsAt)}` : "Walk-in"}</small></span><span className="badge">{entry.status}</span><select aria-label={`Update token ${entry.sequence}`} value={entry.status} disabled={update.isPending || !nextQueueStatuses[entry.status]?.length} onChange={(event) => update.mutate({ id: entry.id, status: event.target.value })}><option value={entry.status}>{entry.status}</option>{(nextQueueStatuses[entry.status] ?? []).map((status) => <option key={status} value={status}>{status}</option>)}</select></div>)}</div>{departmentId && !queue.data?.length && !queue.isLoading && <p className="muted">No queue entries for today.</p>}</section>
    {update.error && <p role="alert" className="error">{messageFrom(update.error)}</p>}
  </>;
}

export default function PortalWorkspace({ page, api, user }: { page: string; api: PortalApi; user: PortalUser }) {
  const account = useQuery<PortalAccount>({
    queryKey: ["portal-account"],
    queryFn: () => api.get("/portal/account").then((response) => response.data.data),
    enabled: user.role === "PATIENT",
  });
  if (page === "Patient Portal") return <PatientPortalPage api={api} user={user}/>;
  if (page === "Family Access") return <FamilyAccessPage api={api} account={account.data}/>;
  if (page === "Notifications") return <NotificationsPage api={api} account={account.data}/>;
  return <CheckInDesk api={api}/>;
}

export function PatientPortalRegistration({ api, onBack, onAuthenticated }: { api: PortalApi; onBack: () => void; onAuthenticated: (user: PortalUser) => void }) {
  return <PatientRegistration api={api} onBack={onBack} onAuthenticated={onAuthenticated}/>;
}

export function PatientFamilyInvitation({ api, token, onAuthenticated, onBack }: { api: PortalApi; token: string; onAuthenticated: (user: PortalUser) => void; onBack: () => void }) {
  return <FamilyInvitationAcceptance api={api} token={token} onAuthenticated={onAuthenticated} onBack={onBack}/>;
}

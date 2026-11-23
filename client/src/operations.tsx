import React from "react";
import type { AxiosInstance } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./operations.css";

type User = { id: string; role: string };
type Patient = { id: string; patientNumber: string; firstName: string; lastName: string };
type Doctor = { id: string; specialty: string; user: { name: string } };
type Room = { id: string; code: string; name: string; active: boolean };
type Invoice = {
  id: string;
  status: string;
  total: string;
  balance: string;
  patient: Patient;
  items: Array<{ id: string; description: string; quantity: number; unitPrice: string }>;
  payments: Array<{ id: string; amount: string; reference: string; refunds: Array<{ id: string; amount: string }> }>;
};
type InsurancePolicy = { id: string; payerName: string; policyNumber: string; active: boolean; patient: Patient };
type Claim = { id: string; claimNumber: string; status: string; requestedAmount: string; approvedAmount?: string | null; invoice: { patient: Patient }; policy?: InsurancePolicy | null };
type ImagingOrder = { id: string; modality: string; bodySite: string; clinicalIndication: string; status: string; scheduledAt?: string | null; report?: string | null; patient: Patient };
type ProcedureCase = { id: string; procedureName: string; status: string; startsAt: string; endsAt: string; patient: Patient; room: Room; surgeon: { user: { name: string } } };
type BloodUnit = { id: string; unitNumber: string; bloodGroup: string; component: string; status: string; expiresAt: string; expired: boolean };
type Ambulance = { id: string; callSign: string; status: string; baseLocation: string };
type Dispatch = { id: string; pickupLocation: string; destination: string; status: string; patient?: Patient | null; ambulance?: Ambulance | null };
type Equipment = { id: string; assetTag: string; name: string; category: string; location: string; status: string; maintenance: Array<{ id: string; description: string; status: string; dueAt?: string | null }> };
type HousekeepingTask = { id: string; type: string; status: string; priority: string; location: string; details?: string | null; assignedTo?: { id: string; name: string } | null };
type OutboxEvent = { id: string; type: string; attempts: number; lastError: string | null; createdAt: string; updatedAt: string };

type Props = { page: string; api: AxiosInstance; user: User };

const adminRoles = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN"];
const financeRoles = [...adminRoles, "BILLING_STAFF", "ACCOUNTANT"];
const errorText = (error: unknown) =>
  typeof error === "object" && error !== null && "response" in error
    ? String((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? "The request failed.")
    : "The request failed.";
const patientLabel = (patient: Patient) => `${patient.patientNumber} · ${patient.firstName} ${patient.lastName}`;
const localDateTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function useRows<T>(api: AxiosInstance, path: string, key: string, enabled = true) {
  return useQuery<T[]>({
    queryKey: ["phase4", key],
    queryFn: () => api.get(path).then((response) => response.data.data as T[]),
    enabled,
  });
}

function useSave(api: AxiosInstance, queryKey: string, path: string, method: "post" | "patch" = "post") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, suffix = "" }: { body: unknown; suffix?: string }) => api[method](`${path}${suffix}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", queryKey] }),
  });
}

function ErrorNotice({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorText(error)}</p> : null;
}

function Panel({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return <section className="panel phase4-panel"><div><h2>{title}</h2><p className="muted">{intro}</p></div>{children}</section>;
}

function usePatientOptions(api: AxiosInstance) {
  return useRows<Patient>(api, "/operations/patients", "patients");
}

function Billing({ api }: { api: AxiosInstance }) {
  const queryClient = useQueryClient();
  const invoices = useRows<Invoice>(api, "/operations/invoices", "invoices");
  const patientQuery = usePatientOptions(api);
  const patients = patientQuery.data ?? [];
  const createInvoice = useSave(api, "invoices", "/operations/invoices");
  const recordPayment = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post(`/operations/invoices/${id}/payments`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "invoices"] }),
  });
  const recordRefund = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post(`/operations/payments/${id}/refunds`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "invoices"] }),
  });
  const [patientId, setPatientId] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [unitPrice, setUnitPrice] = React.useState("");
  const [tax, setTax] = React.useState("0");
  const [paymentDraft, setPaymentDraft] = React.useState<Record<string, { amount: string; reference: string; method: string }>>({});
  const [refundDraft, setRefundDraft] = React.useState<Record<string, { amount: string; reference: string; reason: string }>>({});

  return <>
    <Panel title="Create invoice" intro="Create a manual invoice. Payments and refunds are records only; no money is processed by this app.">
      <form className="phase4-form" onSubmit={(event) => {
        event.preventDefault();
        createInvoice.mutate({ body: { patientId, tax, items: [{ description, quantity: Number(quantity), unitPrice }] } });
        setDescription("");
        setUnitPrice("");
      }}>
        <label>Patient<select value={patientId} onChange={(event) => setPatientId(event.target.value)} required><option value="">Select patient</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patientLabel(patient)}</option>)}</select></label>
        <label>Line item<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} required/></label>
        <label>Quantity<input type="number" min="1" max="100000" value={quantity} onChange={(event) => setQuantity(event.target.value)} required/></label>
        <label>Unit price<input type="number" min="0.01" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required/></label>
        <label>Tax amount<input type="number" min="0" step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} required/></label>
        <button className="primary" disabled={createInvoice.isPending}>Create invoice</button>
      </form>
      <ErrorNotice error={createInvoice.error ?? invoices.error ?? patientQuery.error}/>
    </Panel>
    <Panel title="Invoices and payment records" intro="Balances update atomically. Duplicate references and overpayments are rejected.">
      {invoices.isLoading ? <p className="muted">Loading invoices…</p> : invoices.data?.length ? <div className="phase4-list">{invoices.data.map((invoice) => <article className="phase4-card" key={invoice.id}>
        <div className="phase4-card-head"><strong>{invoice.patient.patientNumber} · {invoice.patient.firstName} {invoice.patient.lastName}</strong><span className="badge">{invoice.status}</span></div>
        <p>Total {Number(invoice.total).toFixed(2)} · Balance {Number(invoice.balance).toFixed(2)}</p>
        <ul>{invoice.items.map((item) => <li key={item.id}>{item.description} × {item.quantity} · {Number(item.unitPrice).toFixed(2)} each</li>)}</ul>
        <form className="phase4-form" onSubmit={(event) => {
          event.preventDefault();
          const draft = paymentDraft[invoice.id];
          recordPayment.mutate({ id: invoice.id, body: draft });
        }}>
          <label>Payment amount<input type="number" min="0.01" max={invoice.balance} step="0.01" value={paymentDraft[invoice.id]?.amount ?? ""} onChange={(event) => setPaymentDraft((current) => ({ ...current, [invoice.id]: { amount: event.target.value, reference: current[invoice.id]?.reference ?? "", method: current[invoice.id]?.method ?? "CASH" } }))} required/></label>
          <label>Reference<input value={paymentDraft[invoice.id]?.reference ?? ""} onChange={(event) => setPaymentDraft((current) => ({ ...current, [invoice.id]: { amount: current[invoice.id]?.amount ?? "", reference: event.target.value, method: current[invoice.id]?.method ?? "CASH" } }))} required minLength={3}/></label>
          <label>Method<select value={paymentDraft[invoice.id]?.method ?? "CASH"} onChange={(event) => setPaymentDraft((current) => ({ ...current, [invoice.id]: { amount: current[invoice.id]?.amount ?? "", reference: current[invoice.id]?.reference ?? "", method: event.target.value } }))}>{["CASH", "CARD", "BANK_TRANSFER", "UPI", "OTHER"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <button className="secondary" disabled={recordPayment.isPending || Number(invoice.balance) <= 0}>Record payment</button>
        </form>
        {invoice.payments.map((payment) => <form className="phase4-form phase4-subform" key={payment.id} onSubmit={(event) => {
          event.preventDefault();
          recordRefund.mutate({ id: payment.id, body: refundDraft[payment.id] });
        }}>
          <span>Payment {payment.reference} · {Number(payment.amount).toFixed(2)} · refunded {payment.refunds.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(2)}</span>
          <label>Refund amount<input type="number" min="0.01" max={payment.amount} step="0.01" value={refundDraft[payment.id]?.amount ?? ""} onChange={(event) => setRefundDraft((current) => ({ ...current, [payment.id]: { amount: event.target.value, reference: current[payment.id]?.reference ?? "", reason: current[payment.id]?.reason ?? "" } }))} required/></label>
          <label>Refund reference<input value={refundDraft[payment.id]?.reference ?? ""} onChange={(event) => setRefundDraft((current) => ({ ...current, [payment.id]: { amount: current[payment.id]?.amount ?? "", reference: event.target.value, reason: current[payment.id]?.reason ?? "" } }))} required minLength={3}/></label>
          <label>Reason<input value={refundDraft[payment.id]?.reason ?? ""} onChange={(event) => setRefundDraft((current) => ({ ...current, [payment.id]: { amount: current[payment.id]?.amount ?? "", reference: current[payment.id]?.reference ?? "", reason: event.target.value } }))} required minLength={5}/></label>
          <button className="secondary" disabled={recordRefund.isPending}>Record manual refund</button>
        </form>)}
      </article>)}</div> : <p className="muted">No invoices recorded yet.</p>}
      <ErrorNotice error={recordPayment.error ?? recordRefund.error ?? invoices.error}/>
    </Panel>
  </>;
}

function Insurance({ api }: { api: AxiosInstance }) {
  const queryClient = useQueryClient();
  const policies = useRows<InsurancePolicy>(api, "/operations/insurance/policies", "policies");
  const claims = useRows<Claim>(api, "/operations/insurance/claims", "claims");
  const invoices = useRows<Invoice>(api, "/operations/invoices", "invoices");
  const patientQuery = usePatientOptions(api);
  const patients = patientQuery.data ?? [];
  const createPolicy = useSave(api, "policies", "/operations/insurance/policies");
  const createClaim = useSave(api, "claims", "/operations/insurance/claims");
  const updatePolicy = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/operations/insurance/policies/${id}/status`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "policies"] }),
  });
  const updateClaim = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.patch(`/operations/insurance/claims/${id}/status`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "claims"] }),
  });
  const [policyDraft, setPolicyDraft] = React.useState({ patientId: "", payerName: "", policyNumber: "", memberNumber: "", validFrom: localDateTime(new Date()).slice(0, 10), validUntil: "" });
  const [claimDraft, setClaimDraft] = React.useState({ invoiceId: "", policyId: "", claimNumber: "", requestedAmount: "", notes: "" });
  const [claimAmounts, setClaimAmounts] = React.useState<Record<string, string>>({});
  return <>
    <Panel title="Insurance policies" intro="Store policy details for manual claims administration. No payer connection or eligibility check is performed.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createPolicy.mutate({ body: { ...policyDraft, validUntil: policyDraft.validUntil || undefined } }); }}>
        <label>Patient<select value={policyDraft.patientId} onChange={(event) => setPolicyDraft({ ...policyDraft, patientId: event.target.value })} required><option value="">Select patient</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patientLabel(patient)}</option>)}</select></label>
        <label>Payer<input value={policyDraft.payerName} onChange={(event) => setPolicyDraft({ ...policyDraft, payerName: event.target.value })} required maxLength={120}/></label>
        <label>Policy number<input value={policyDraft.policyNumber} onChange={(event) => setPolicyDraft({ ...policyDraft, policyNumber: event.target.value })} required maxLength={120}/></label>
        <label>Member number<input value={policyDraft.memberNumber} onChange={(event) => setPolicyDraft({ ...policyDraft, memberNumber: event.target.value })} maxLength={120}/></label>
        <label>Valid from<input type="date" value={policyDraft.validFrom} onChange={(event) => setPolicyDraft({ ...policyDraft, validFrom: event.target.value })} required/></label>
        <label>Valid until<input type="date" value={policyDraft.validUntil} onChange={(event) => setPolicyDraft({ ...policyDraft, validUntil: event.target.value })}/></label>
        <button className="primary" disabled={createPolicy.isPending}>Add policy</button>
      </form>
      <div className="phase4-list">{(policies.data ?? []).map((policy) => <div className="phase4-card phase4-inline" key={policy.id}>
        <span><strong>{policy.patient.patientNumber} · {policy.payerName}</strong><small>Policy {policy.policyNumber}</small></span>
        <button className="secondary" onClick={() => updatePolicy.mutate({ id: policy.id, active: !policy.active })}>{policy.active ? "Deactivate" : "Reactivate"}</button>
      </div>)}</div>
      <ErrorNotice error={createPolicy.error ?? updatePolicy.error ?? policies.error ?? patientQuery.error}/>
    </Panel>
    <Panel title="Claims" intro="Move claims through audited manual states. Approved amounts do not create payments automatically.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createClaim.mutate({ body: { ...claimDraft, notes: claimDraft.notes || undefined } }); }}>
        <label>Invoice<select value={claimDraft.invoiceId} onChange={(event) => setClaimDraft({ ...claimDraft, invoiceId: event.target.value })} required><option value="">Select invoice</option>{(invoices.data ?? []).map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.patient.patientNumber} · {Number(invoice.total).toFixed(2)} · {invoice.status}</option>)}</select></label>
        <label>Policy<select value={claimDraft.policyId} onChange={(event) => setClaimDraft({ ...claimDraft, policyId: event.target.value })} required><option value="">Select policy</option>{(policies.data ?? []).filter((policy) => policy.active).map((policy) => <option key={policy.id} value={policy.id}>{policy.patient.patientNumber} · {policy.payerName} · {policy.policyNumber}</option>)}</select></label>
        <label>Claim reference<input value={claimDraft.claimNumber} onChange={(event) => setClaimDraft({ ...claimDraft, claimNumber: event.target.value })} required maxLength={120}/></label>
        <label>Requested amount<input type="number" min="0.01" step="0.01" value={claimDraft.requestedAmount} onChange={(event) => setClaimDraft({ ...claimDraft, requestedAmount: event.target.value })} required/></label>
        <label>Notes<input value={claimDraft.notes} onChange={(event) => setClaimDraft({ ...claimDraft, notes: event.target.value })} maxLength={2000}/></label>
        <button className="primary" disabled={createClaim.isPending}>Create draft claim</button>
      </form>
      <div className="phase4-list">{(claims.data ?? []).map((claim) => <div className="phase4-card" key={claim.id}>
        <div className="phase4-card-head"><strong>{claim.claimNumber} · {claim.invoice.patient.patientNumber} · {claim.policy?.payerName ?? "Policy unavailable"}</strong><span className="badge">{claim.status}</span></div>
        <p>Requested {Number(claim.requestedAmount).toFixed(2)}{claim.approvedAmount ? ` · Approved ${Number(claim.approvedAmount).toFixed(2)}` : ""}</p>
        <form className="phase4-form" onSubmit={(event) => {
          event.preventDefault();
          const status = (event.currentTarget.elements.namedItem("status") as HTMLSelectElement).value;
          updateClaim.mutate({ id: claim.id, body: { status, approvedAmount: claimAmounts[claim.id] || undefined } });
        }}>
          <label>Next status<select name="status" defaultValue="">{["SUBMITTED", "IN_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "DENIED", "PAID", "CANCELLED"].map((status) => <option key={status}>{status}</option>)}</select></label>
          <label>Approved amount<input type="number" min="0.01" step="0.01" value={claimAmounts[claim.id] ?? ""} onChange={(event) => setClaimAmounts({ ...claimAmounts, [claim.id]: event.target.value })}/></label>
          <button className="secondary" disabled={updateClaim.isPending}>Update claim</button>
        </form>
      </div>)}</div>
      <ErrorNotice error={createClaim.error ?? updateClaim.error ?? claims.error ?? patientQuery.error}/>
    </Panel>
  </>;
}

function Radiology({ api, user }: { api: AxiosInstance; user: User }) {
  const queryClient = useQueryClient();
  const orders = useRows<ImagingOrder>(api, "/operations/radiology/orders", "imaging");
  const patientQuery = usePatientOptions(api);
  const patients = patientQuery.data ?? [];
  const createOrder = useSave(api, "imaging", "/operations/radiology/orders");
  const updateStatus = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.patch(`/operations/radiology/orders/${id}/status`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "imaging"] }),
  });
  const submitReport = useMutation({
    mutationFn: ({ id, report }: { id: string; report: string }) => api.patch(`/operations/radiology/orders/${id}/report`, { report }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "imaging"] }),
  });
  const [draft, setDraft] = React.useState({ patientId: "", modality: "X_RAY", bodySite: "", clinicalIndication: "" });
  const [scheduledAt, setScheduledAt] = React.useState<Record<string, string>>({});
  const [reports, setReports] = React.useState<Record<string, string>>({});
  return <>
    {user.role !== "RADIOLOGIST" && <Panel title="Request imaging" intro="A clinician's indication is recorded as entered; the system does not generate imaging advice.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createOrder.mutate({ body: draft }); setDraft({ patientId: "", modality: "X_RAY", bodySite: "", clinicalIndication: "" }); }}>
        <label>Patient<select value={draft.patientId} onChange={(event) => setDraft({ ...draft, patientId: event.target.value })} required><option value="">Select patient</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patientLabel(patient)}</option>)}</select></label>
        <label>Modality<select value={draft.modality} onChange={(event) => setDraft({ ...draft, modality: event.target.value })}>{["X_RAY", "CT", "MRI", "ULTRASOUND", "MAMMOGRAPHY", "OTHER"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Body site<input value={draft.bodySite} onChange={(event) => setDraft({ ...draft, bodySite: event.target.value })} required maxLength={120}/></label>
        <label>Clinical indication<input value={draft.clinicalIndication} onChange={(event) => setDraft({ ...draft, clinicalIndication: event.target.value })} required maxLength={1000}/></label>
        <button className="primary" disabled={createOrder.isPending}>Request imaging</button>
      </form><ErrorNotice error={createOrder.error ?? patientQuery.error}/>
    </Panel>}
    <Panel title="Imaging worklist" intro="Reports are entered and signed off manually by authorized radiology staff.">
      {orders.isLoading ? <p className="muted">Loading imaging orders…</p> : <div className="phase4-list">{(orders.data ?? []).map((order) => <article className="phase4-card" key={order.id}>
        <div className="phase4-card-head"><strong>{order.patient.patientNumber} · {order.modality} · {order.bodySite}</strong><span className="badge">{order.status}</span></div>
        <p>{order.clinicalIndication}</p>
        {order.report && <pre className="phase4-report">{order.report}</pre>}
        {["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "RADIOLOGIST"].includes(user.role) && order.status !== "COMPLETED" && order.status !== "CANCELLED" && <form className="phase4-form" onSubmit={(event) => {
          event.preventDefault();
          const status = (event.currentTarget.elements.namedItem("status") as HTMLSelectElement).value;
          updateStatus.mutate({ id: order.id, body: { status, scheduledAt: status === "SCHEDULED" ? (scheduledAt[order.id] || localDateTime(new Date())) : undefined } });
        }}>
          {order.status === "REQUESTED" && <label>Scheduled at<input type="datetime-local" value={scheduledAt[order.id] ?? localDateTime(new Date())} onChange={(event) => setScheduledAt({ ...scheduledAt, [order.id]: event.target.value })}/></label>}
          <label>Next status<select name="status" defaultValue="">{(order.status === "REQUESTED" ? ["SCHEDULED", "IN_PROGRESS", "CANCELLED"] : order.status === "SCHEDULED" ? ["IN_PROGRESS", "CANCELLED"] : ["CANCELLED"]).map((status) => <option key={status}>{status}</option>)}</select></label>
          <button className="secondary">Update status</button>
        </form>}
        {["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN", "RADIOLOGIST"].includes(user.role) && order.status === "IN_PROGRESS" && <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); submitReport.mutate({ id: order.id, report: reports[order.id] ?? "" }); }}>
          <label>Report<textarea rows={3} value={reports[order.id] ?? ""} onChange={(event) => setReports({ ...reports, [order.id]: event.target.value })} required maxLength={20000}/></label><button className="primary">Complete with report</button>
        </form>}
      </article>)}</div>}
      <ErrorNotice error={orders.error ?? updateStatus.error ?? submitReport.error}/>
    </Panel>
  </>;
}

function OperatingTheatre({ api, user }: { api: AxiosInstance; user: User }) {
  const queryClient = useQueryClient();
  const cases = useRows<ProcedureCase>(api, "/operations/ot/cases", "cases");
  const rooms = useRows<Room>(api, "/operations/ot/rooms", "rooms");
  const doctors = useRows<Doctor>(api, "/operations/doctors", "doctors");
  const patientQuery = usePatientOptions(api);
  const patients = patientQuery.data ?? [];
  const createRoom = useSave(api, "rooms", "/operations/ot/rooms");
  const createCase = useSave(api, "cases", "/operations/ot/cases");
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/operations/ot/cases/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "cases"] }),
  });
  const [roomDraft, setRoomDraft] = React.useState({ code: "", name: "" });
  const [draft, setDraft] = React.useState({ patientId: "", surgeonId: "", roomId: "", procedureName: "", startsAt: localDateTime(new Date(Date.now() + 60 * 60 * 1000)), endsAt: localDateTime(new Date(Date.now() + 2 * 60 * 60 * 1000)), operationalNotes: "" });
  return <>
    {adminRoles.includes(user.role) && <Panel title="Operating rooms" intro="Configure active rooms for manual case scheduling.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createRoom.mutate({ body: roomDraft }); setRoomDraft({ code: "", name: "" }); }}>
        <label>Room code<input value={roomDraft.code} onChange={(event) => setRoomDraft({ ...roomDraft, code: event.target.value })} required maxLength={40}/></label><label>Room name<input value={roomDraft.name} onChange={(event) => setRoomDraft({ ...roomDraft, name: event.target.value })} required maxLength={120}/></label><button className="primary">Add room</button>
      </form><ErrorNotice error={createRoom.error}/>
    </Panel>}
    <Panel title="Schedule procedure" intro="Overlapping active cases for the same room or surgeon are rejected. This is an operational schedule, not clinical guidance.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createCase.mutate({ body: { ...draft, operationalNotes: draft.operationalNotes || undefined } }); }}>
        <label>Patient<select value={draft.patientId} onChange={(event) => setDraft({ ...draft, patientId: event.target.value })} required><option value="">Select patient</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patientLabel(patient)}</option>)}</select></label>
        <label>Surgeon<select value={draft.surgeonId} onChange={(event) => setDraft({ ...draft, surgeonId: event.target.value })} required><option value="">Select surgeon</option>{doctors.data?.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.user.name} · {doctor.specialty}</option>)}</select></label>
        <label>Operating room<select value={draft.roomId} onChange={(event) => setDraft({ ...draft, roomId: event.target.value })} required><option value="">Select room</option>{rooms.data?.filter((room) => room.active).map((room) => <option key={room.id} value={room.id}>{room.code} · {room.name}</option>)}</select></label>
        <label>Procedure name<input value={draft.procedureName} onChange={(event) => setDraft({ ...draft, procedureName: event.target.value })} required maxLength={200}/></label>
        <label>Starts<input type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} required/></label>
        <label>Ends<input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} required/></label>
        <label>Operational notes<input value={draft.operationalNotes} onChange={(event) => setDraft({ ...draft, operationalNotes: event.target.value })} maxLength={2000}/></label><button className="primary" disabled={createCase.isPending}>Schedule case</button>
      </form><ErrorNotice error={createCase.error ?? rooms.error ?? doctors.error ?? patientQuery.error}/>
    </Panel>
    <Panel title="Procedure schedule" intro="Case status transitions are controlled by the server.">
      <div className="phase4-list">{(cases.data ?? []).map((item) => <div className="phase4-card phase4-inline" key={item.id}>
        <span><strong>{item.patient.patientNumber} · {item.procedureName}</strong><small>{new Date(item.startsAt).toLocaleString()} · {item.room.code} · {item.surgeon.user.name} · {item.status}</small></span>
        {!["COMPLETED", "CANCELLED"].includes(item.status) && <select aria-label={`Next status for ${item.procedureName}`} value="" onChange={(event) => updateStatus.mutate({ id: item.id, status: event.target.value })}><option value="">Advance status</option>{(item.status === "PLANNED" ? ["SCHEDULED", "CANCELLED"] : item.status === "SCHEDULED" ? ["IN_PROGRESS", "CANCELLED"] : ["COMPLETED"]).map((status) => <option key={status}>{status}</option>)}</select>}
      </div>)}</div><ErrorNotice error={cases.error ?? updateStatus.error}/>
    </Panel>
  </>;
}

function BloodBank({ api }: { api: AxiosInstance }) {
  const queryClient = useQueryClient();
  const units = useRows<BloodUnit>(api, "/operations/blood-bank/units", "blood");
  const createUnit = useSave(api, "blood", "/operations/blood-bank/units");
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/operations/blood-bank/units/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "blood"] }),
  });
  const [draft, setDraft] = React.useState({ unitNumber: "", bloodGroup: "UNKNOWN", component: "RED_CELLS", collectedAt: new Date().toISOString().slice(0, 10), expiresAt: "" });
  return <>
    <Panel title="Blood product inventory" intro="Track units and expiry only. This module does not determine compatibility, crossmatch, or transfusion decisions.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createUnit.mutate({ body: { ...draft, collectedAt: new Date(draft.collectedAt), expiresAt: new Date(draft.expiresAt) } }); }}>
        <label>Unit number<input value={draft.unitNumber} onChange={(event) => setDraft({ ...draft, unitNumber: event.target.value })} pattern="[A-Za-z0-9-]{4,60}" required/></label>
        <label>Blood group<select value={draft.bloodGroup} onChange={(event) => setDraft({ ...draft, bloodGroup: event.target.value })}>{["UNKNOWN", "O_POSITIVE", "O_NEGATIVE", "A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Component<select value={draft.component} onChange={(event) => setDraft({ ...draft, component: event.target.value })}>{["RED_CELLS", "PLASMA", "PLATELETS", "CRYOPRECIPITATE"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Collected<input type="date" value={draft.collectedAt} onChange={(event) => setDraft({ ...draft, collectedAt: event.target.value })} required/></label>
        <label>Expires<input type="date" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} required/></label>
        <button className="primary">Add unit</button>
      </form><ErrorNotice error={createUnit.error}/>
    </Panel>
    <Panel title="Units" intro="Expired units cannot be reserved or issued; irreversible states remain blocked by the API.">
      <div className="phase4-list">{(units.data ?? []).map((unit) => <div className="phase4-card phase4-inline" key={unit.id}>
        <span><strong>{unit.unitNumber} · {unit.bloodGroup} · {unit.component}</strong><small>Expires {new Date(unit.expiresAt).toLocaleDateString()} {unit.expired ? "· EXPIRED" : ""} · {unit.status}</small></span>
        {!["DISCARDED"].includes(unit.status) && <select aria-label={`Status for ${unit.unitNumber}`} value="" onChange={(event) => updateStatus.mutate({ id: unit.id, status: event.target.value })}><option value="">Change status</option>{({ AVAILABLE: ["RESERVED", "QUARANTINED", "DISCARDED"], RESERVED: ["AVAILABLE", "ISSUED", "QUARANTINED", "DISCARDED"], ISSUED: ["RETURNED", "QUARANTINED"], RETURNED: ["QUARANTINED", "DISCARDED"], QUARANTINED: ["DISCARDED"] } as Record<string, string[]>)[unit.status]?.map((status) => <option key={status}>{status}</option>)}</select>}
      </div>)}</div><ErrorNotice error={units.error ?? updateStatus.error}/>
    </Panel>
  </>;
}

function AmbulanceDesk({ api, user }: { api: AxiosInstance; user: User }) {
  const queryClient = useQueryClient();
  const ambulances = useRows<Ambulance>(api, "/operations/ambulances", "ambulances");
  const dispatches = useRows<Dispatch>(api, "/operations/ambulance/dispatches", "dispatches");
  const patientQuery = usePatientOptions(api);
  const patients = patientQuery.data ?? [];
  const createAmbulance = useSave(api, "ambulances", "/operations/ambulances");
  const createDispatch = useSave(api, "dispatches", "/operations/ambulance/dispatches");
  const updateStatus = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.patch(`/operations/ambulance/dispatches/${id}/status`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phase4", "dispatches"] });
      queryClient.invalidateQueries({ queryKey: ["phase4", "ambulances"] });
    },
  });
  const [vehicle, setVehicle] = React.useState({ callSign: "", baseLocation: "", description: "" });
  const [request, setRequest] = React.useState({ patientId: "", pickupLocation: "", destination: "", notes: "" });
  const [selectedAmbulance, setSelectedAmbulance] = React.useState<Record<string, string>>({});
  return <>
    {adminRoles.includes(user.role) && <Panel title="Fleet" intro="Maintain an operational fleet list. Dispatch and GPS integrations are not connected.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createAmbulance.mutate({ body: vehicle }); setVehicle({ callSign: "", baseLocation: "", description: "" }); }}>
        <label>Call sign<input value={vehicle.callSign} onChange={(event) => setVehicle({ ...vehicle, callSign: event.target.value })} required maxLength={40}/></label><label>Base location<input value={vehicle.baseLocation} onChange={(event) => setVehicle({ ...vehicle, baseLocation: event.target.value })} required maxLength={200}/></label><label>Description<input value={vehicle.description} onChange={(event) => setVehicle({ ...vehicle, description: event.target.value })} maxLength={200}/></label><button className="primary">Add ambulance</button>
      </form><ErrorNotice error={createAmbulance.error}/>
    </Panel>}
    <Panel title="Request dispatch" intro="Dispatch records are manually operated; they do not contact emergency services or provide location tracking.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createDispatch.mutate({ body: { ...request, patientId: request.patientId || undefined, notes: request.notes || undefined } }); setRequest({ patientId: "", pickupLocation: "", destination: "", notes: "" }); }}>
        <label>Patient (optional)<select value={request.patientId} onChange={(event) => setRequest({ ...request, patientId: event.target.value })}><option value="">No linked patient</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>{patientLabel(patient)}</option>)}</select></label>
        <label>Pickup location<input value={request.pickupLocation} onChange={(event) => setRequest({ ...request, pickupLocation: event.target.value })} required maxLength={200}/></label><label>Destination<input value={request.destination} onChange={(event) => setRequest({ ...request, destination: event.target.value })} required maxLength={200}/></label><label>Notes<input value={request.notes} onChange={(event) => setRequest({ ...request, notes: event.target.value })} maxLength={1000}/></label><button className="primary">Request</button>
      </form><ErrorNotice error={createDispatch.error ?? ambulances.error ?? patientQuery.error}/>
    </Panel>
    <Panel title="Dispatch queue" intro="Only the dispatch desk can assign vehicles and advance trip state.">
      <div className="phase4-list">{(dispatches.data ?? []).map((dispatch) => <div className="phase4-card phase4-inline" key={dispatch.id}>
        <span><strong>{dispatch.pickupLocation} → {dispatch.destination}</strong><small>{dispatch.patient ? `${dispatch.patient.patientNumber} · ` : ""}{dispatch.ambulance?.callSign ?? "No vehicle"} · {dispatch.status}</small></span>
        {adminRoles.concat("RECEPTIONIST").includes(user.role) && !["COMPLETED", "CANCELLED"].includes(dispatch.status) && <form className="phase4-inline-form" onSubmit={(event) => {
          event.preventDefault();
          const status = (event.currentTarget.elements.namedItem("status") as HTMLSelectElement).value;
          updateStatus.mutate({ id: dispatch.id, body: { status, ambulanceId: selectedAmbulance[dispatch.id] || undefined } });
        }}>
          {dispatch.status === "REQUESTED" && <select aria-label="Select ambulance" value={selectedAmbulance[dispatch.id] ?? ""} onChange={(event) => setSelectedAmbulance({ ...selectedAmbulance, [dispatch.id]: event.target.value })}><option value="">Select vehicle</option>{ambulances.data?.filter((item) => item.status === "AVAILABLE").map((item) => <option key={item.id} value={item.id}>{item.callSign}</option>)}</select>}
          <select name="status" defaultValue="">{(dispatch.status === "REQUESTED" ? ["DISPATCHED", "CANCELLED"] : dispatch.status === "DISPATCHED" ? ["EN_ROUTE", "CANCELLED"] : dispatch.status === "EN_ROUTE" ? ["ARRIVED", "CANCELLED"] : ["COMPLETED"]).map((status) => <option key={status}>{status}</option>)}</select><button className="secondary">Update</button>
        </form>}
      </div>)}</div><ErrorNotice error={dispatches.error ?? ambulances.error ?? updateStatus.error}/>
    </Panel>
  </>;
}

function EquipmentDesk({ api, user }: { api: AxiosInstance; user: User }) {
  const queryClient = useQueryClient();
  const equipment = useRows<Equipment>(api, "/operations/equipment", "equipment");
  const create = useSave(api, "equipment", "/operations/equipment");
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/operations/equipment/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "equipment"] }),
  });
  const createMaintenance = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post(`/operations/equipment/${id}/maintenance`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "equipment"] }),
  });
  const updateMaintenance = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/operations/equipment/maintenance/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "equipment"] }),
  });
  const [draft, setDraft] = React.useState({ assetTag: "", name: "", category: "", location: "", nextMaintenanceAt: "", notes: "" });
  const [maintenanceDescriptions, setMaintenanceDescriptions] = React.useState<Record<string, string>>({});
  return <>
    {adminRoles.includes(user.role) && <Panel title="Register equipment" intro="Track assets and maintenance dates. No device telemetry or vendor connection is configured.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); create.mutate({ body: { ...draft, nextMaintenanceAt: draft.nextMaintenanceAt || undefined, notes: draft.notes || undefined } }); setDraft({ assetTag: "", name: "", category: "", location: "", nextMaintenanceAt: "", notes: "" }); }}>
        <label>Asset tag<input value={draft.assetTag} onChange={(event) => setDraft({ ...draft, assetTag: event.target.value })} required maxLength={80}/></label><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={160}/></label><label>Category<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} required maxLength={120}/></label><label>Location<input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} required maxLength={200}/></label><label>Next maintenance date<input type="date" value={draft.nextMaintenanceAt} onChange={(event) => setDraft({ ...draft, nextMaintenanceAt: event.target.value })}/></label><label>Notes<input value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} maxLength={1000}/></label><button className="primary">Register</button>
      </form><ErrorNotice error={create.error}/>
    </Panel>}
    <Panel title="Equipment and maintenance" intro="Maintenance work orders control the maintenance state until all open work is complete.">
      <div className="phase4-list">{(equipment.data ?? []).map((asset) => <article className="phase4-card" key={asset.id}>
        <div className="phase4-card-head"><strong>{asset.assetTag} · {asset.name}</strong><span className="badge">{asset.status}</span></div><p>{asset.category} · {asset.location}</p>
        {adminRoles.includes(user.role) && <select aria-label={`Status for ${asset.assetTag}`} value={asset.status} onChange={(event) => updateStatus.mutate({ id: asset.id, status: event.target.value })}>{["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"].map((status) => <option key={status}>{status}</option>)}</select>}
        <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); createMaintenance.mutate({ id: asset.id, body: { description: maintenanceDescriptions[asset.id] } }); }}>
          <label>Maintenance request<input value={maintenanceDescriptions[asset.id] ?? ""} onChange={(event) => setMaintenanceDescriptions({ ...maintenanceDescriptions, [asset.id]: event.target.value })} required maxLength={1000}/></label><button className="secondary">Open work order</button>
        </form>
        {asset.maintenance.map((item) => <div className="phase4-inline" key={item.id}><span>{item.description} · {item.status}</span>{!["COMPLETED", "CANCELLED"].includes(item.status) && <select aria-label={`Maintenance status ${item.id}`} value="" onChange={(event) => updateMaintenance.mutate({ id: item.id, status: event.target.value })}><option value="">Advance work order</option>{(item.status === "OPEN" ? ["IN_PROGRESS", "CANCELLED"] : ["COMPLETED", "CANCELLED"]).map((status) => <option key={status}>{status}</option>)}</select>}</div>)}
      </article>)}</div><ErrorNotice error={equipment.error ?? updateStatus.error ?? createMaintenance.error ?? updateMaintenance.error}/>
    </Panel>
  </>;
}

function Housekeeping({ api, user }: { api: AxiosInstance; user: User }) {
  const queryClient = useQueryClient();
  const tasks = useRows<HousekeepingTask>(api, "/operations/housekeeping/tasks", "housekeeping");
  const create = useSave(api, "housekeeping", "/operations/housekeeping/tasks");
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/operations/housekeeping/tasks/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["phase4", "housekeeping"] }),
  });
  const [draft, setDraft] = React.useState({ type: "ROUTINE_CLEANING", priority: "NORMAL", location: "", details: "" });
  return <>
    <Panel title="Create housekeeping task" intro="Staff can self-assign open tasks; only authorized housekeeping users can work them.">
      <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); create.mutate({ body: { ...draft, details: draft.details || undefined } }); setDraft({ type: "ROUTINE_CLEANING", priority: "NORMAL", location: "", details: "" }); }}>
        <label>Task type<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>{["ROUTINE_CLEANING", "TERMINAL_CLEANING", "LINEN_CHANGE", "SPILL_RESPONSE", "WASTE_REMOVAL", "OTHER"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Priority<select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>{["LOW", "NORMAL", "HIGH", "URGENT"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Location<input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} required maxLength={200}/></label><label>Details<input value={draft.details} onChange={(event) => setDraft({ ...draft, details: event.target.value })} maxLength={1000}/></label><button className="primary">Create task</button>
      </form><ErrorNotice error={create.error}/>
    </Panel>
    <Panel title="Task queue" intro="Housekeeping staff see tasks assigned to them and unassigned open tasks.">
      <div className="phase4-list">{(tasks.data ?? []).map((task) => <div className="phase4-card phase4-inline" key={task.id}>
        <span><strong>{task.type} · {task.priority}</strong><small>{task.location} · {task.assignedTo?.name ?? "Unassigned"} · {task.status}{task.details ? ` · ${task.details}` : ""}</small></span>
        {!["COMPLETED", "CANCELLED"].includes(task.status) && <select aria-label={`Next status for ${task.location}`} value="" onChange={(event) => update.mutate({ id: task.id, status: event.target.value })}><option value="">Advance task</option>{(task.status === "OPEN" ? ["ASSIGNED", "CANCELLED"] : task.status === "ASSIGNED" ? ["IN_PROGRESS", "CANCELLED"] : ["COMPLETED", "CANCELLED"]).map((status) => <option key={status}>{status}</option>)}</select>}
      </div>)}</div><ErrorNotice error={tasks.error ?? update.error}/>
    </Panel>
    {user.role === "HOUSEKEEPING" && <p className="muted">Selecting ASSIGNED assigns the task to your account.</p>}
  </>;
}

function EventDelivery({ api }: { api: AxiosInstance }) {
  const client = useQueryClient();
  const outbox = useQuery<{ counts: Record<string, number>; failedEvents: OutboxEvent[] }>({
    queryKey: ["phase5", "outbox"],
    queryFn: () => api.get("/operations/outbox").then((response) => response.data.data),
    refetchInterval: 30_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/operations/outbox/${id}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["phase5", "outbox"] }),
  });
  return <Panel title="Reliable event delivery" intro="Events retry automatically on the scheduled runner. Failed events can be inspected and retried by an administrator.">
    {outbox.isLoading && <p className="muted">Loading event status…</p>}
    {outbox.isError && <ErrorNotice error={outbox.error}/>}
    {outbox.data && <>
      <div className="phase4-inline">
        {["PENDING", "PROCESSING", "COMPLETED", "FAILED"].map((status) => <span key={status}><strong>{outbox.data?.counts[status] ?? 0}</strong><small>{status}</small></span>)}
      </div>
      {outbox.data.failedEvents.length ? <div className="phase4-list">{outbox.data.failedEvents.map((event) => <div className="phase4-card phase4-inline" key={event.id}>
        <span><strong>{event.type} · {event.attempts} attempts</strong><small>{event.lastError ?? "No error details"} · {new Date(event.updatedAt).toLocaleString()}</small></span>
        <button className="secondary" disabled={retry.isPending} onClick={() => retry.mutate(event.id)}>Retry event</button>
      </div>)}</div> : <p className="muted">No permanently failed events.</p>}
      <ErrorNotice error={retry.error}/>
    </>}
  </Panel>;
}

const tabs = [
  { id: "billing", label: "Billing", roles: financeRoles },
  { id: "insurance", label: "Insurance", roles: financeRoles },
  { id: "radiology", label: "Radiology", roles: [...adminRoles, "DOCTOR", "RADIOLOGIST"] },
  { id: "ot", label: "Operating theatre", roles: [...adminRoles, "DOCTOR"] },
  { id: "blood", label: "Blood bank", roles: [...adminRoles, "LAB_TECHNICIAN"] },
  { id: "ambulance", label: "Ambulance", roles: [...adminRoles, "RECEPTIONIST", "DOCTOR", "NURSE"] },
  { id: "equipment", label: "Equipment", roles: [...adminRoles, "HOUSEKEEPING"] },
  { id: "housekeeping", label: "Housekeeping", roles: [...adminRoles, "HOUSEKEEPING"] },
  { id: "events", label: "Event delivery", roles: adminRoles },
];

export default function OperationsWorkspace({ page, api, user }: Props) {
  const availableTabs = tabs.filter((tab) => tab.roles.includes(user.role));
  const initialTab = page === "Billing & Payments" ? "billing" : availableTabs[0]?.id ?? "";
  const [selected, setSelected] = React.useState(initialTab);
  React.useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === selected)) setSelected(initialTab);
  }, [selected, initialTab, availableTabs]);
  const tab = availableTabs.find((item) => item.id === selected);
  return <>
    <p className="eyebrow">PHASE 4 · MANUAL OPERATIONAL WORKFLOWS</p>
    <div className="page-head"><div><h1>{page === "Billing & Payments" ? "Billing & Payments" : "Operational and Financial Workflows"}</h1><p className="muted">Staff-managed records with backend-enforced access and audited status changes.</p></div></div>
    <div className="phase4-tabs" role="tablist" aria-label="Operational modules">{availableTabs.map((item) => <button key={item.id} role="tab" aria-selected={selected === item.id} className={selected === item.id ? "active" : ""} onClick={() => setSelected(item.id)}>{item.label}</button>)}</div>
    {tab?.id === "billing" && <Billing api={api}/>}
    {tab?.id === "insurance" && <Insurance api={api}/>}
    {tab?.id === "radiology" && <Radiology api={api} user={user}/>}
    {tab?.id === "ot" && <OperatingTheatre api={api} user={user}/>}
    {tab?.id === "blood" && <BloodBank api={api}/>}
    {tab?.id === "ambulance" && <AmbulanceDesk api={api} user={user}/>}
    {tab?.id === "equipment" && <EquipmentDesk api={api} user={user}/>}
    {tab?.id === "housekeeping" && <Housekeeping api={api} user={user}/>}
    {tab?.id === "events" && <EventDelivery api={api}/>}
  </>;
}

import React from "react";
import type { AxiosInstance } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./operations.css";

type User = { role: string };
type Admission = {
  id: string;
  status: string;
  admittedAt: string;
  patient: { patientNumber: string; firstName: string; lastName: string };
  bed: { label: string; ward: { name: string } };
};
type Checklist = {
  id: string;
  approvedAt: string | null;
  finalizedAt: string | null;
  approvedBy: { name: string } | null;
  items: Array<{
    id: string;
    label: string;
    completedAt: string | null;
    createdBy: { name: string };
    completedBy: { name: string } | null;
  }>;
};

function requestError(error: unknown) {
  if (typeof error === "object" && error !== null && "response" in error) {
    return String((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? "The request failed.");
  }
  return "The request failed.";
}

export default function DischargeWorkspace({ api, user }: { api: AxiosInstance; user: User }) {
  const client = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const admissions = useQuery<{ items: Admission[]; page: number; limit: number; total: number }>({
    queryKey: ["admissions", page],
    queryFn: () => api.get("/admissions", { params: { page, limit: 20 } }).then((response) => response.data.data),
    refetchInterval: 15_000,
  });
  const admissionRecords = admissions.data?.items ?? [];
  const activeAdmissions = admissionRecords.filter((admission) => admission.status === "ACTIVE");
  React.useEffect(() => {
    if (!admissionRecords.some((admission) => admission.id === selectedId)) {
      setSelectedId(activeAdmissions[0]?.id ?? "");
    }
  }, [admissionRecords, activeAdmissions, selectedId]);
  const checklist = useQuery<Checklist | null>({
    queryKey: ["discharge-checklist", selectedId],
    queryFn: () => api.get(`/admissions/${selectedId}/discharge-checklist`).then((response) => response.data.data),
    enabled: Boolean(selectedId),
    refetchInterval: 15_000,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["admissions"] }),
      client.invalidateQueries({ queryKey: ["discharge-checklist", selectedId] }),
      client.invalidateQueries({ queryKey: ["summary"] }),
      client.invalidateQueries({ queryKey: ["operations", "twin"] }),
    ]);
  };
  const addItem = useMutation({
    mutationFn: () => api.post(`/admissions/${selectedId}/discharge-checklist/items`, { label }),
    onSuccess: async () => { setLabel(""); await refresh(); },
  });
  const completeItem = useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
      api.patch(`/admissions/${selectedId}/discharge-checklist/items/${id}`, { completed }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => api.post(`/admissions/${selectedId}/discharge-checklist/approve`),
    onSuccess: refresh,
  });

  const admission = admissionRecords.find((item) => item.id === selectedId);
  const locked = Boolean(admission?.status !== "ACTIVE" || checklist.data?.approvedAt || checklist.data?.finalizedAt);
  const busy = addItem.isPending || completeItem.isPending || approve.isPending;
  const error = addItem.error ?? completeItem.error ?? approve.error;

  return <>
    <p className="eyebrow">PHASE 5 · DISCHARGE WORKFLOW</p>
    <div className="page-head"><div><h1>Admissions &amp; discharges</h1><p className="muted">A clinician must explicitly approve discharge. Finalization occurs when every checklist item is complete.</p></div></div>
    {admissions.isLoading && <p className="muted">Loading active admissions…</p>}
    {admissions.isError && <p className="error" role="alert">{requestError(admissions.error)}</p>}
    {!admissions.isLoading && !admissions.isError && admissionRecords.length === 0 && <section className="panel"><p className="muted">There are no admissions to display.</p></section>}
    {admissions.data && admissions.data.total > 0 && <>
      <section className="panel phase5-discharge-panel">
        <nav className="record-pagination" aria-label="Admissions pagination">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page} · Showing {(page - 1) * admissions.data.limit + 1}–{Math.min(page * admissions.data.limit, admissions.data.total)} of {admissions.data.total}</span>
          <button type="button" className="secondary" disabled={page * admissions.data.limit >= admissions.data.total} onClick={() => setPage((value) => value + 1)}>Next</button>
        </nav>
        <label className="phase5-admission-select">Admission
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            {admissionRecords.map((item) => <option key={item.id} value={item.id}>
              {item.patient.patientNumber} · {item.patient.firstName} {item.patient.lastName} · {item.bed.ward.name} / {item.bed.label} · {item.status}
            </option>)}
          </select>
        </label>
        {admission && <p className="muted">Admitted {new Date(admission.admittedAt).toLocaleDateString()} · Bed {admission.bed.ward.name} / {admission.bed.label}</p>}
        {checklist.isLoading && <p className="muted">Loading discharge checklist…</p>}
        {checklist.isError && <p className="error" role="alert">{requestError(checklist.error)}</p>}
        {!checklist.isLoading && !checklist.isError && <>
          {checklist.data?.finalizedAt
            ? <p className="phase5-success" role="status">Discharge finalized {new Date(checklist.data.finalizedAt).toLocaleString()}.</p>
            : checklist.data?.approvedAt
              ? <p className="muted">Clinician approval recorded by {checklist.data.approvedBy?.name ?? "a clinician"}. Required checklist items remain.</p>
              : <p className="muted">No clinical readiness is inferred. A doctor records explicit approval after the operational checklist is prepared.</p>}
          <div className="phase5-checklist">
            {checklist.data?.items.map((item) => <div className="phase5-checklist-item" key={item.id}>
              <span><strong>{item.label}</strong><small>{item.completedAt ? `Completed by ${item.completedBy?.name ?? "staff"} · ${new Date(item.completedAt).toLocaleString()}` : `Added by ${item.createdBy.name}`}</small></span>
              {!checklist.data?.finalizedAt && <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => completeItem.mutate({ id: item.id, completed: !item.completedAt })}
              >{item.completedAt ? "Reopen" : "Mark complete"}</button>}
            </div>)}
            {!checklist.data?.items.length && <p className="muted">Add at least one required item before clinician approval.</p>}
          </div>
          {!locked && <form className="phase4-form" onSubmit={(event) => { event.preventDefault(); addItem.mutate(); }}>
            <label>Required operational task<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} required/></label>
            <button className="secondary" disabled={busy}>Add checklist item</button>
          </form>}
          {!locked && user.role === "DOCTOR" && <button
            className="primary"
            disabled={busy || !checklist.data?.items.length}
            onClick={() => approve.mutate()}
          >{approve.isPending ? "Recording approval…" : "Record clinician discharge approval"}</button>}
          {!locked && user.role !== "DOCTOR" && <p className="muted">Only a doctor can record clinical discharge approval.</p>}
        </>}
        {error && <p className="error" role="alert">{requestError(error)}</p>}
      </section>
    </>}
  </>;
}

import React from "react";
import type { AxiosInstance } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type ClinicalUser = { id: string; role: string };
type ClinicalApi = Pick<AxiosInstance, "get" | "post" | "patch">;
type Patient = { id: string; patientNumber: string; firstName: string; lastName: string };
type ClinicalField = {
  id: string;
  key: string;
  label: string;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT";
  appliesTo: string[];
  options: string[];
  required: boolean;
  active: boolean;
};
type ClinicalRecord = {
  id: string;
  patientId: string;
  type: string;
  status: string;
  version: number;
  title: string;
  narrative?: string | null;
  structuredData: Record<string, unknown>;
  authoredById: string;
  previousVersionId?: string | null;
  revisionReason?: string | null;
  signedBy?: { name: string } | null;
  createdAt: string;
};
type Medicine = {
  id: string;
  name: string;
  sku: string;
  dosageForms: string[];
  strengths: string[];
  routes: string[];
  formularyEnabled: boolean;
};
type Prescription = {
  id: string;
  patientId: string;
  status: string;
  patient: Patient;
  items: Array<{
    id: string;
    dose: string;
    strength: string | null;
    dosageForm: string | null;
    route: string;
    frequency: string;
    duration: string | null;
    quantity: number;
    instructions: string | null;
    medicine: { id: string; name: string; sku: string };
  }>;
  prescribedBy: { id: string; name: string };
  signedBy?: { name: string } | null;
};
type NursingTask = {
  id: string;
  title: string;
  details?: string | null;
  status: string;
  dueAt?: string | null;
  assignedTo?: { name: string } | null;
  patient: Patient;
};
type EmergencyVisit = {
  id: string;
  patientId: string;
  chiefComplaint: string;
  triageNotes?: string | null;
  status: string;
  triageCategory?: { id: string; label: string; priority: number; active?: boolean } | null;
  patient: Patient;
};
type Admission = { id: string; patientId: string; status: string };

const clinicalTypes: Record<string, string[]> = {
  DOCTOR: ["CONSULTATION", "CARE_PLAN", "DISCHARGE_SUMMARY", "TRIAGE_NOTE"],
  NURSE: ["NURSING_NOTE", "TRIAGE_NOTE"],
};
const adminRoles = ["SUPER_ADMIN", "HOSPITAL_ADMIN", "ADMIN"];
const titleForType = (type: string) => type.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
const errorText = (error: unknown) =>
  typeof error === "object" && error !== null && "response" in error
    ? String((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? "The request failed.")
    : "The request failed.";

function usePatients(api: ClinicalApi, enabled: boolean) {
  return useQuery<Patient[]>({
    queryKey: ["clinical-patients"],
    queryFn: () => api.get("/patients?limit=100").then((response) => response.data.data.items as Patient[]),
    enabled,
  });
}

function PatientPicker({ patients, value, onChange, disabled = false }: { patients: Patient[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <label>Patient<select value={value} onChange={(event) => onChange(event.target.value)} required disabled={disabled}>
    <option value="">Select a patient</option>
    {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.patientNumber} · {patient.firstName} {patient.lastName}</option>)}
  </select></label>;
}

function FieldValues({ fields, type, values, onChange }: {
  fields: ClinicalField[];
  type: string;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const applicable = fields.filter((field) => field.active && (!field.appliesTo.length || field.appliesTo.includes(type)));
  if (!applicable.length) return <p className="muted">No custom fields are configured for this record type.</p>;
  return <div className="clinical-form-grid">{applicable.map((field) => {
    const value = values[field.key];
    if (field.type === "BOOLEAN") {
      return <label className="clinical-checkbox" key={field.id}><input type="checkbox" checked={value === true} onChange={(event) => onChange(field.key, event.target.checked)}/>{field.label}{field.required ? " *" : ""}</label>;
    }
    if (field.type === "SINGLE_SELECT") {
      return <label key={field.id}>{field.label}{field.required ? " *" : ""}<select value={typeof value === "string" ? value : ""} required={field.required} onChange={(event) => onChange(field.key, event.target.value || undefined)}><option value="">Select a configured value</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
    }
    if (field.type === "MULTI_SELECT") {
      const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      return <label key={field.id}>{field.label}{field.required ? " *" : ""}<select multiple value={selected} required={field.required && !selected.length} onChange={(event) => onChange(field.key, Array.from(event.target.selectedOptions, (option) => option.value))}>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
    }
    const inputType = field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : "text";
    const inputValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return <label key={field.id}>{field.label}{field.required ? " *" : ""}<input type={inputType} value={inputValue} required={field.required} onChange={(event) => {
      const next = event.target.value;
      onChange(field.key, field.type === "NUMBER" ? (next === "" ? undefined : Number(next)) : (next || undefined));
    }}/></label>;
  })}</div>;
}

function ClinicalFieldManager({ api }: { api: ClinicalApi }) {
  const queryClient = useQueryClient();
  const fieldsQuery = useQuery<ClinicalField[]>({
    queryKey: ["clinical-fields", "admin"],
    queryFn: () => api.get("/clinical/fields?includeInactive=true").then((response) => response.data.data as ClinicalField[]),
  });
  const [key, setKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [type, setType] = React.useState<ClinicalField["type"]>("TEXT");
  const [options, setOptions] = React.useState("");
  const [appliesTo, setAppliesTo] = React.useState<string[]>([]);
  const [required, setRequired] = React.useState(false);
  const save = useMutation({
    mutationFn: (field: Partial<ClinicalField> & { key: string }) => api.post("/clinical/fields", field),
    onSuccess: () => {
      setKey(""); setLabel(""); setOptions(""); setAppliesTo([]); setRequired(false);
      queryClient.invalidateQueries({ queryKey: ["clinical-fields", "admin"] });
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/clinical/fields/${id}`, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clinical-fields", "admin"] }),
  });
  const selectType = type === "SINGLE_SELECT" || type === "MULTI_SELECT";
  return <section className="panel phase2-panel">
    <h2>Clinical documentation fields</h2>
    <p className="muted">Configure keys and allowed values used by clinical staff. Deactivation hides a field from new entries without altering historical records.</p>
    <form className="clinical-form-grid" onSubmit={(event) => {
      event.preventDefault();
      const parsedOptions = selectType ? options.split(",").map((item) => item.trim()).filter(Boolean) : [];
      save.mutate({ key, label, type, options: parsedOptions, appliesTo, required });
    }}>
      <label>Field key<input value={key} onChange={(event) => setKey(event.target.value)} pattern="[a-z][a-zA-Z0-9_]{0,62}" required/></label>
      <label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={120}/></label>
      <label>Value type<select value={type} onChange={(event) => setType(event.target.value as ClinicalField["type"])}>{["TEXT", "NUMBER", "BOOLEAN", "DATE", "SINGLE_SELECT", "MULTI_SELECT"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      {selectType && <label>Allowed values (comma-separated)<input value={options} onChange={(event) => setOptions(event.target.value)} required/></label>}
      <label>Applies to (none means all types)<select multiple value={appliesTo} onChange={(event) => setAppliesTo(Array.from(event.target.selectedOptions, (option) => option.value))}>{["CONSULTATION", "NURSING_NOTE", "CARE_PLAN", "DISCHARGE_SUMMARY", "TRIAGE_NOTE"].map((item) => <option key={item} value={item}>{titleForType(item)}</option>)}</select></label>
      <label className="clinical-checkbox"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)}/>Required for new records</label>
      <button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Add field"}</button>
    </form>
    {save.error && <p className="error" role="alert">{errorText(save.error)}</p>}
    {fieldsQuery.isError && <p className="error" role="alert">{errorText(fieldsQuery.error)}</p>}
    <div className="clinical-list">{(fieldsQuery.data ?? []).map((field) => <div className="clinical-row" key={field.id}>
      <span><strong>{field.label}</strong><small>{field.key} · {field.type}{field.required ? " · required" : ""}</small></span>
      <button className="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: field.id, active: !field.active })}>{field.active ? "Deactivate" : "Reactivate"}</button>
    </div>)}</div>
  </section>;
}

function ClinicalRecordsPage({ api, user }: { api: ClinicalApi; user: ClinicalUser }) {
  const queryClient = useQueryClient();
  const isClinician = clinicalTypes[user.role] !== undefined;
  const patientsQuery = usePatients(api, isClinician);
  const [patientId, setPatientId] = React.useState("");
  const [type, setType] = React.useState(clinicalTypes[user.role]?.[0] ?? "CONSULTATION");
  const [title, setTitle] = React.useState("");
  const [narrative, setNarrative] = React.useState("");
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [editingId, setEditingId] = React.useState("");
  const [amendId, setAmendId] = React.useState("");
  const [amendReason, setAmendReason] = React.useState("");
  const [signConfirmations, setSignConfirmations] = React.useState<Record<string, boolean>>({});
  const fieldsQuery = useQuery<ClinicalField[]>({
    queryKey: ["clinical-fields", type],
    queryFn: () => api.get("/clinical/fields").then((response) => response.data.data as ClinicalField[]),
    enabled: isClinician,
  });
  const recordsQuery = useQuery<ClinicalRecord[]>({
    queryKey: ["clinical-records", patientId],
    queryFn: () => api.get(`/clinical/records?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data as ClinicalRecord[]),
    enabled: isClinician && Boolean(patientId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["clinical-records", patientId] });
  const save = useMutation({
    mutationFn: () => {
      const body = { patientId, type, title, narrative: narrative || undefined, structuredData: values };
      return editingId ? api.patch(`/clinical/records/${editingId}`, body) : api.post("/clinical/records", body);
    },
    onSuccess: () => {
      setTitle(""); setNarrative(""); setValues({}); setEditingId("");
      void refresh();
    },
  });
  const sign = useMutation({
    mutationFn: (id: string) => api.post(`/clinical/records/${id}/sign`, { reviewConfirmed: true }),
    onSuccess: () => void refresh(),
  });
  const amend = useMutation({
    mutationFn: (id: string) => api.post(`/clinical/records/${id}/amend`, { reason: amendReason }),
    onSuccess: () => { setAmendId(""); setAmendReason(""); void refresh(); },
  });
  const editDraft = (record: ClinicalRecord) => {
    setType(record.type);
    setTitle(record.title);
    setNarrative(record.narrative ?? "");
    setValues(record.structuredData ?? {});
    setEditingId(record.id);
  };
  if (!isClinician) return <><p className="eyebrow">CLINICAL CONFIGURATION</p><div className="page-head"><div><h1>Clinical documentation</h1><p className="muted">Manage configurable documentation fields. Clinical record content is restricted to clinicians.</p></div></div><ClinicalFieldManager api={api}/></>;
  const patientList = patientsQuery.data ?? [];
  return <><p className="eyebrow">CLINICAL RECORDS</p><div className="page-head"><div><h1>Clinical documentation</h1><p className="muted">Clinician-authored records are versioned; signing locks that version. Amendments create a linked draft.</p></div></div>
    <form className="panel phase2-panel" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      {patientsQuery.isError && <p className="error" role="alert">{errorText(patientsQuery.error)}</p>}
      <div className="clinical-form-grid">
        <PatientPicker patients={patientList} value={patientId} onChange={(id) => { setPatientId(id); setEditingId(""); }}/>
        <label>Record type<select value={type} onChange={(event) => { setType(event.target.value); setValues({}); }}>{clinicalTypes[user.role].map((item) => <option key={item} value={item}>{titleForType(item)}</option>)}</select></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required/></label>
      </div>
      <label>Clinical narrative<textarea value={narrative} onChange={(event) => setNarrative(event.target.value)} rows={4} maxLength={20_000}/></label>
      <FieldValues fields={fieldsQuery.data ?? []} type={type} values={values} onChange={(key, value) => setValues((current) => {
        const next = { ...current };
        if (value === undefined || value === "") delete next[key];
        else next[key] = value;
        return next;
      })}/>
      {save.error && <p className="error" role="alert">{errorText(save.error)}</p>}
      <div className="clinical-actions"><button className="primary" disabled={save.isPending || !patientId}>{save.isPending ? "Saving…" : editingId ? "Save new version" : "Save draft"}</button>{editingId && <button type="button" className="secondary" onClick={() => { setEditingId(""); setTitle(""); setNarrative(""); setValues({}); }}>Cancel edit</button>}</div>
    </form>
    <section className="panel phase2-panel">
      <h2>Patient record history</h2>
      {recordsQuery.isLoading && <p className="muted">Loading clinical records…</p>}
      {recordsQuery.isError && <p className="error" role="alert">{errorText(recordsQuery.error)}</p>}
      {!recordsQuery.isLoading && !recordsQuery.data?.length && <p className="muted">No clinical records found for this patient.</p>}
      <div className="clinical-list">{(recordsQuery.data ?? []).map((record) => <article className="clinical-record" key={record.id}>
        <div className="clinical-record-head"><div><strong>{record.title}</strong><small>{titleForType(record.type)} · version {record.version} · {new Date(record.createdAt).toLocaleString()}</small></div><span className={`badge ${record.status === "SIGNED" ? "clinical-signed" : ""}`}>{record.status}</span></div>
        {record.narrative && <p>{record.narrative}</p>}
        {Object.keys(record.structuredData ?? {}).length > 0 && <pre className="clinical-data">{JSON.stringify(record.structuredData, null, 2)}</pre>}
        {record.signedBy && <small className="muted">Signed by {record.signedBy.name}</small>}
        {record.revisionReason && <small className="muted">Revision: {record.revisionReason}</small>}
        <div className="clinical-actions">
          {record.status === "DRAFT" && <><button className="secondary" onClick={() => editDraft(record)}>Revise draft</button><label className="clinical-checkbox"><input type="checkbox" checked={signConfirmations[record.id] ?? false} onChange={(event) => setSignConfirmations((current) => ({ ...current, [record.id]: event.target.checked }))}/>I reviewed this record</label><button className="primary" disabled={sign.isPending || !signConfirmations[record.id]} onClick={() => sign.mutate(record.id)}>Sign and lock</button></>}
          {record.status === "SIGNED" && <button className="secondary" onClick={() => { setAmendId(amendId === record.id ? "" : record.id); setAmendReason(""); }}>Start amendment</button>}
        </div>
        {amendId === record.id && <form className="clinical-inline-form" onSubmit={(event) => { event.preventDefault(); amend.mutate(record.id); }}>
          <label>Amendment reason<input value={amendReason} onChange={(event) => setAmendReason(event.target.value)} minLength={10} maxLength={500} required/></label>
          <button className="primary" disabled={amend.isPending}>{amend.isPending ? "Creating…" : "Create amendment draft"}</button>
        </form>}
      </article>)}</div>
      {(sign.error || amend.error) && <p className="error" role="alert">{errorText(sign.error ?? amend.error)}</p>}
    </section>
  </>;
}

function optionList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function FormularyManager({ api }: { api: ClinicalApi }) {
  const queryClient = useQueryClient();
  const medicinesQuery = useQuery<Medicine[]>({
    queryKey: ["formulary", "configuration"],
    queryFn: () => api.get("/formulary?includeDisabled=true").then((response) => response.data.data as Medicine[]),
  });
  const [name, setName] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [dosageForms, setDosageForms] = React.useState("");
  const [strengths, setStrengths] = React.useState("");
  const [routes, setRoutes] = React.useState("");
  const [medicineId, setMedicineId] = React.useState("");
  const selected = medicinesQuery.data?.find((medicine) => medicine.id === medicineId);
  React.useEffect(() => {
    setDosageForms(selected?.dosageForms.join(", ") ?? "");
    setStrengths(selected?.strengths.join(", ") ?? "");
    setRoutes(selected?.routes.join(", ") ?? "");
  }, [medicineId, medicinesQuery.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["formulary"] });
  const create = useMutation({
    mutationFn: () => api.post("/formulary", {
      name,
      sku,
      expiresAt: new Date(expiresAt).toISOString(),
      dosageForms: optionList(dosageForms),
      strengths: optionList(strengths),
      routes: optionList(routes),
    }),
    onSuccess: () => {
      setName(""); setSku(""); setExpiresAt(""); setDosageForms(""); setStrengths(""); setRoutes("");
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: () => api.patch(`/formulary/${medicineId}`, {
      dosageForms: optionList(dosageForms),
      strengths: optionList(strengths),
      routes: optionList(routes),
      formularyEnabled: true,
    }),
    onSuccess: () => void refresh(),
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.patch(`/formulary/${id}`, { formularyEnabled: false }),
    onSuccess: () => void refresh(),
  });
  return <section className="panel phase2-panel">
    <h2>Medication formulary settings</h2>
    <p className="muted">Form, strength, and route options are configured by authorized staff. No dose or frequency suggestions are supplied.</p>
    <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <label>Medication name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required/></label>
      <label>Inventory SKU<input value={sku} onChange={(event) => setSku(event.target.value)} maxLength={80} required/></label>
      <label>Inventory expiry date<input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required/></label>
      <label>Configured dosage forms<input value={dosageForms} onChange={(event) => setDosageForms(event.target.value)} placeholder="Comma-separated configured values" required/></label>
      <label>Configured strengths<input value={strengths} onChange={(event) => setStrengths(event.target.value)} placeholder="Comma-separated configured values" required/></label>
      <label>Configured routes<input value={routes} onChange={(event) => setRoutes(event.target.value)} placeholder="Comma-separated configured values" required/></label>
      <button className="primary" disabled={create.isPending}>{create.isPending ? "Saving…" : "Add formulary medication"}</button>
    </form>
    {create.error && <p className="error" role="alert">{errorText(create.error)}</p>}
    <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
      <label>Existing inventory medication<select value={medicineId} onChange={(event) => setMedicineId(event.target.value)}><option value="">Select a medication</option>{(medicinesQuery.data ?? []).map((medicine) => <option key={medicine.id} value={medicine.id}>{medicine.name} · {medicine.sku}{medicine.formularyEnabled ? "" : " · not enabled"}</option>)}</select></label>
      <label>Configured dosage forms<input value={dosageForms} onChange={(event) => setDosageForms(event.target.value)} disabled={!medicineId} required/></label>
      <label>Configured strengths<input value={strengths} onChange={(event) => setStrengths(event.target.value)} disabled={!medicineId} required/></label>
      <label>Configured routes<input value={routes} onChange={(event) => setRoutes(event.target.value)} disabled={!medicineId} required/></label>
      <button className="secondary" disabled={!medicineId || update.isPending}>{update.isPending ? "Saving…" : "Save formulary settings"}</button>
      {selected?.formularyEnabled && <button type="button" className="secondary" disabled={disable.isPending} onClick={() => disable.mutate(selected.id)}>Disable prescribing</button>}
    </form>
    {(update.error || disable.error || medicinesQuery.error) && <p className="error" role="alert">{errorText(update.error ?? disable.error ?? medicinesQuery.error)}</p>}
  </section>;
}

function PrescriptionsPage({ api, user }: { api: ClinicalApi; user: ClinicalUser }) {
  const queryClient = useQueryClient();
  const isClinicalUser = ["DOCTOR", "NURSE", "PHARMACIST"].includes(user.role);
  const canPrescribe = user.role === "DOCTOR";
  const canConfigure = user.role === "PHARMACIST" || adminRoles.includes(user.role);
  const patientsQuery = usePatients(api, canPrescribe);
  const medicinesQuery = useQuery<Medicine[]>({
    queryKey: ["formulary", "active"],
    queryFn: () => api.get("/formulary").then((response) => response.data.data as Medicine[]),
    enabled: canPrescribe,
  });
  const prescriptionsQuery = useQuery<Prescription[]>({
    queryKey: ["prescriptions", user.role],
    queryFn: () => api.get("/prescriptions").then((response) => response.data.data as Prescription[]),
    enabled: isClinicalUser,
  });
  const [patientId, setPatientId] = React.useState("");
  const [medicineId, setMedicineId] = React.useState("");
  const [dose, setDose] = React.useState("");
  const [strength, setStrength] = React.useState("");
  const [dosageForm, setDosageForm] = React.useState("");
  const [route, setRoute] = React.useState("");
  const [frequency, setFrequency] = React.useState("");
  const [duration, setDuration] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [editingId, setEditingId] = React.useState("");
  const [cancelReasons, setCancelReasons] = React.useState<Record<string, string>>({});
  const [signConfirmations, setSignConfirmations] = React.useState<Record<string, boolean>>({});
  const selectedMedicine = medicinesQuery.data?.find((medicine) => medicine.id === medicineId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["prescriptions"] });
  const save = useMutation({
    mutationFn: async () => {
      const item = {
        medicineId,
        dose,
        strength,
        dosageForm,
        route,
        frequency,
        duration: duration || undefined,
        quantity: Number(quantity),
        instructions: instructions || undefined,
      };
      if (editingId) {
        await api.patch(`/prescriptions/${editingId}`, { items: [item] });
      } else {
        await api.post("/prescriptions", { patientId, items: [item] });
      }
    },
    onSuccess: () => {
      setEditingId("");
      setMedicineId(""); setDose(""); setStrength(""); setDosageForm(""); setRoute(""); setFrequency(""); setDuration(""); setQuantity(""); setInstructions("");
      void refresh();
    },
  });
  const sign = useMutation({
    mutationFn: (id: string) => api.post(`/prescriptions/${id}/sign`, { reviewConfirmed: true }),
    onSuccess: () => void refresh(),
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/prescriptions/${id}/cancel`, { reason }),
    onSuccess: () => void refresh(),
  });
  return <><p className="eyebrow">MEDICATION ORDERS</p><div className="page-head"><div><h1>Prescriptions</h1><p className="muted">Medication details are entered by clinicians from configured formulary options; prescriptions require a clinician signature.</p></div></div>
    {canConfigure && <FormularyManager api={api}/>}
    {canPrescribe && <section className="panel phase2-panel"><h2>{editingId ? "Edit prescription draft" : "Create a prescription draft"}</h2>
      <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <PatientPicker patients={patientsQuery.data ?? []} value={patientId} onChange={setPatientId} disabled={Boolean(editingId)}/>
        <label>Formulary medication<select value={medicineId} onChange={(event) => { setMedicineId(event.target.value); setStrength(""); setDosageForm(""); setRoute(""); }} required><option value="">Select a configured medication</option>{(medicinesQuery.data ?? []).map((medicine) => <option key={medicine.id} value={medicine.id}>{medicine.name} · {medicine.sku}</option>)}</select></label>
        <label>Dose<input value={dose} onChange={(event) => setDose(event.target.value)} maxLength={120} required/></label>
        <label>Strength<select value={strength} onChange={(event) => setStrength(event.target.value)} required disabled={!selectedMedicine}><option value="">Select a configured strength</option>{(selectedMedicine?.strengths ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Dosage form<select value={dosageForm} onChange={(event) => setDosageForm(event.target.value)} required disabled={!selectedMedicine}><option value="">Select a configured dosage form</option>{(selectedMedicine?.dosageForms ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Route<select value={route} onChange={(event) => setRoute(event.target.value)} required disabled={!selectedMedicine}><option value="">Select a configured route</option>{(selectedMedicine?.routes ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Frequency<input value={frequency} onChange={(event) => setFrequency(event.target.value)} maxLength={160} required/></label>
        <label>Duration (optional)<input value={duration} onChange={(event) => setDuration(event.target.value)} maxLength={120}/></label>
        <label>Quantity<input type="number" min="1" max="100000" value={quantity} onChange={(event) => setQuantity(event.target.value)} required/></label>
        <label>Instructions (optional)<input value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={1000}/></label>
        <button className="primary" disabled={save.isPending || !patientId}>{save.isPending ? "Saving…" : editingId ? "Save draft changes" : "Save prescription draft"}</button>
        {editingId && <button type="button" className="secondary" onClick={() => { setEditingId(""); setMedicineId(""); setDose(""); setStrength(""); setDosageForm(""); setRoute(""); setFrequency(""); setDuration(""); setQuantity(""); setInstructions(""); }}>Cancel editing</button>}
      </form>
      {save.error && <p className="error" role="alert">{errorText(save.error)}</p>}
      {medicinesQuery.isError && <p className="error" role="alert">{errorText(medicinesQuery.error)}</p>}
    </section>}
    {isClinicalUser && <section className="panel phase2-panel"><h2>Prescriptions</h2>
      {prescriptionsQuery.isLoading && <p className="muted">Loading prescriptions…</p>}
      {prescriptionsQuery.isError && <p className="error" role="alert">{errorText(prescriptionsQuery.error)}</p>}
      {!prescriptionsQuery.isLoading && !prescriptionsQuery.data?.length && <p className="muted">No prescriptions are available for this role.</p>}
      <div className="clinical-list">{(prescriptionsQuery.data ?? []).map((prescription) => <article className="clinical-record" key={prescription.id}>
        <div className="clinical-record-head"><div><strong>{prescription.patient.patientNumber} · {prescription.patient.firstName} {prescription.patient.lastName}</strong><small>Prescribed by {prescription.prescribedBy.name}{prescription.signedBy ? ` · Signed by ${prescription.signedBy.name}` : ""}</small></div><span className="badge">{prescription.status}</span></div>
        <ul className="prescription-items">{prescription.items.map((item) => <li key={item.id}><strong>{item.medicine.name}</strong> · {item.dose} · {item.strength} · {item.dosageForm} · {item.route} · {item.frequency}{item.duration ? ` · ${item.duration}` : ""} · quantity {item.quantity}{item.instructions ? ` · ${item.instructions}` : ""}</li>)}</ul>
        {canPrescribe && prescription.prescribedBy.id === user.id && (prescription.status === "DRAFT" || prescription.status === "SIGNED") && <div className="clinical-actions">
          {prescription.status === "DRAFT" && <>
            <button type="button" className="secondary" disabled={save.isPending || prescription.items.length !== 1} onClick={() => {
              const item = prescription.items[0];
              if (!item) return;
              setEditingId(prescription.id); setPatientId(prescription.patientId); setMedicineId(item.medicine.id); setDose(item.dose); setStrength(item.strength ?? ""); setDosageForm(item.dosageForm ?? ""); setRoute(item.route); setFrequency(item.frequency); setDuration(item.duration ?? ""); setQuantity(String(item.quantity)); setInstructions(item.instructions ?? "");
            }}>Edit draft{prescription.items.length !== 1 ? " (single-item drafts only)" : ""}</button>
            <label className="clinical-checkbox"><input type="checkbox" checked={signConfirmations[prescription.id] ?? false} onChange={(event) => setSignConfirmations((current) => ({ ...current, [prescription.id]: event.target.checked }))}/>I reviewed this prescription</label><button className="primary" disabled={sign.isPending || !signConfirmations[prescription.id]} onClick={() => sign.mutate(prescription.id)}>Review and sign</button>
          </>}
          <label>Cancellation reason<input value={cancelReasons[prescription.id] ?? ""} minLength={10} maxLength={500} onChange={(event) => setCancelReasons((current) => ({ ...current, [prescription.id]: event.target.value }))}/></label><button className="secondary" disabled={cancel.isPending || (cancelReasons[prescription.id] ?? "").trim().length < 10} onClick={() => cancel.mutate({ id: prescription.id, reason: cancelReasons[prescription.id] })}>Cancel prescription</button>
        </div>}
      </article>)}</div>
      {(sign.error || cancel.error) && <p className="error" role="alert">{errorText(sign.error ?? cancel.error)}</p>}
    </section>}
  </>;
}

function NursingPage({ api, user }: { api: ClinicalApi; user: ClinicalUser }) {
  const queryClient = useQueryClient();
  const isNurse = user.role === "NURSE";
  const patientsQuery = usePatients(api, true);
  const admissionsQuery = useQuery<Admission[]>({
    queryKey: ["nursing-admissions"],
    queryFn: () => api.get("/admissions", { params: { status: "ACTIVE", limit: 100 } }).then((response) => response.data.data.items as Admission[]),
  });
  const [patientId, setPatientId] = React.useState("");
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskDetails, setTaskDetails] = React.useState("");
  const [handoverSummary, setHandoverSummary] = React.useState("");
  const [prescriptionItemId, setPrescriptionItemId] = React.useState("");
  const [administeredDose, setAdministeredDose] = React.useState("");
  const [administeredRoute, setAdministeredRoute] = React.useState("");
  const [administrationNotes, setAdministrationNotes] = React.useState("");
  const admittedPatientIds = new Set((admissionsQuery.data ?? []).filter((admission) => admission.status === "ACTIVE").map((admission) => admission.patientId));
  const admittedPatients = (patientsQuery.data ?? []).filter((patient) => admittedPatientIds.has(patient.id));
  const tasksQuery = useQuery<NursingTask[]>({
    queryKey: ["nursing-tasks", patientId],
    queryFn: () => api.get(`/nursing/tasks?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data as NursingTask[]),
    enabled: Boolean(patientId),
  });
  const handoversQuery = useQuery<Array<{ id: string; summary: string; createdAt: string; sentBy: { name: string }; receivedBy?: { name: string } | null }>>({
    queryKey: ["nursing-handovers", patientId],
    queryFn: () => api.get(`/nursing/handovers?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: Boolean(patientId),
  });
  const prescriptionsQuery = useQuery<Prescription[]>({
    queryKey: ["prescriptions", "nursing", patientId],
    queryFn: () => api.get(`/prescriptions?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data as Prescription[]),
    enabled: isNurse && Boolean(patientId),
  });
  const administrationsQuery = useQuery<Array<{ id: string; administeredDose: string; administeredRoute: string; administeredAt: string; prescriptionItem: { medicine: { name: string } } }>>({
    queryKey: ["nursing-administrations", patientId],
    queryFn: () => api.get(`/nursing/medication-administrations?patientId=${encodeURIComponent(patientId)}`).then((response) => response.data.data),
    enabled: isNurse && Boolean(patientId),
  });
  const refreshTasks = () => queryClient.invalidateQueries({ queryKey: ["nursing-tasks", patientId] });
  const refreshHandovers = () => queryClient.invalidateQueries({ queryKey: ["nursing-handovers", patientId] });
  const refreshAdministrations = () => queryClient.invalidateQueries({ queryKey: ["nursing-administrations", patientId] });
  const createTask = useMutation({
    mutationFn: () => api.post("/nursing/tasks", { patientId, title: taskTitle, details: taskDetails || undefined }),
    onSuccess: () => { setTaskTitle(""); setTaskDetails(""); void refreshTasks(); },
  });
  const updateTask = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/nursing/tasks/${id}/status`, { status }),
    onSuccess: () => void refreshTasks(),
  });
  const createHandover = useMutation({
    mutationFn: () => api.post("/nursing/handovers", { patientId, summary: handoverSummary }),
    onSuccess: () => { setHandoverSummary(""); void refreshHandovers(); },
  });
  const createAdministration = useMutation({
    mutationFn: () => api.post("/nursing/medication-administrations", { patientId, prescriptionItemId, administeredDose, administeredRoute, notes: administrationNotes || undefined }),
    onSuccess: () => { setPrescriptionItemId(""); setAdministeredDose(""); setAdministeredRoute(""); setAdministrationNotes(""); void refreshAdministrations(); },
  });
  const signedItems = (prescriptionsQuery.data ?? []).filter((prescription) => prescription.status === "SIGNED").flatMap((prescription) =>
    prescription.items.map((item) => ({ ...item, patientLabel: `${prescription.patient.patientNumber} · ${prescription.patient.firstName} ${prescription.patient.lastName}` })),
  );
  return <><p className="eyebrow">NURSING WORKFLOWS</p><div className="page-head"><div><h1>Nursing</h1><p className="muted">Tasks, handovers, and factual medication-administration records for patients with active admissions.</p></div></div>
    <section className="panel phase2-panel"><div className="clinical-form-grid"><PatientPicker patients={admittedPatients} value={patientId} onChange={setPatientId}/></div>
      {patientsQuery.error && <p className="error" role="alert">{errorText(patientsQuery.error)}</p>}
      {admissionsQuery.error && <p className="error" role="alert">{errorText(admissionsQuery.error)}</p>}
    </section>
    <section className="panel phase2-panel"><h2>Nursing tasks</h2>
      <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); createTask.mutate(); }}>
        <label>Task title<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={160} required/></label>
        <label>Details (optional)<input value={taskDetails} onChange={(event) => setTaskDetails(event.target.value)} maxLength={4000}/></label>
        <button className="primary" disabled={!patientId || createTask.isPending}>{createTask.isPending ? "Saving…" : "Create task"}</button>
      </form>
      {createTask.error && <p className="error" role="alert">{errorText(createTask.error)}</p>}
      {tasksQuery.error && <p className="error" role="alert">{errorText(tasksQuery.error)}</p>}
      <div className="clinical-list">{(tasksQuery.data ?? []).map((task) => <div className="clinical-row" key={task.id}>
        <span><strong>{task.title} · {task.status}</strong><small>{task.patient.patientNumber} · {task.patient.firstName} {task.patient.lastName}{task.assignedTo ? ` · assigned to ${task.assignedTo.name}` : " · unassigned"}</small>{task.details && <small>{task.details}</small>}</span>
        {task.status === "OPEN" && <button className="secondary" disabled={updateTask.isPending} onClick={() => updateTask.mutate({ id: task.id, status: "IN_PROGRESS" })}>Start</button>}
        {task.status === "IN_PROGRESS" && <button className="primary" disabled={updateTask.isPending} onClick={() => updateTask.mutate({ id: task.id, status: "COMPLETED" })}>Complete</button>}
      </div>)}</div>
      {updateTask.error && <p className="error" role="alert">{errorText(updateTask.error)}</p>}
    </section>
    <section className="panel phase2-panel"><h2>Nursing handover</h2>
      {isNurse && <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); createHandover.mutate(); }}>
        <label>Handover summary<textarea value={handoverSummary} onChange={(event) => setHandoverSummary(event.target.value)} maxLength={5000} required rows={3}/></label>
        <button className="primary" disabled={!patientId || createHandover.isPending}>{createHandover.isPending ? "Saving…" : "Record handover"}</button>
      </form>}
      {createHandover.error && <p className="error" role="alert">{errorText(createHandover.error)}</p>}
      {handoversQuery.error && <p className="error" role="alert">{errorText(handoversQuery.error)}</p>}
      <div className="clinical-list">{(handoversQuery.data ?? []).map((handover) => <article className="clinical-record" key={handover.id}><strong>{handover.sentBy.name}{handover.receivedBy ? ` → ${handover.receivedBy.name}` : ""} · {new Date(handover.createdAt).toLocaleString()}</strong><p>{handover.summary}</p></article>)}</div>
    </section>
    {isNurse && <section className="panel phase2-panel"><h2>Record medication administration</h2>
      <p className="muted">This records an administration against a signed prescription; it does not calculate or recommend a dose.</p>
      <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); createAdministration.mutate(); }}>
        <label>Signed prescription item<select value={prescriptionItemId} onChange={(event) => setPrescriptionItemId(event.target.value)} required><option value="">Select a signed item</option>{signedItems.map((item) => <option key={item.id} value={item.id}>{item.patientLabel} · {item.medicine.name} · {item.dose} · {item.route}</option>)}</select></label>
        <label>Actual administered dose<input value={administeredDose} onChange={(event) => setAdministeredDose(event.target.value)} maxLength={120} required/></label>
        <label>Actual administered route<input value={administeredRoute} onChange={(event) => setAdministeredRoute(event.target.value)} maxLength={120} required/></label>
        <label>Notes (optional)<input value={administrationNotes} onChange={(event) => setAdministrationNotes(event.target.value)} maxLength={1000}/></label>
        <button className="primary" disabled={!patientId || createAdministration.isPending}>{createAdministration.isPending ? "Recording…" : "Record administration"}</button>
      </form>
      {createAdministration.error && <p className="error" role="alert">{errorText(createAdministration.error)}</p>}
      {prescriptionsQuery.error && <p className="error" role="alert">{errorText(prescriptionsQuery.error)}</p>}
      <div className="clinical-list">{(administrationsQuery.data ?? []).map((item) => <div className="clinical-row" key={item.id}><span><strong>{item.prescriptionItem.medicine.name} · {item.administeredDose} · {item.administeredRoute}</strong><small>{new Date(item.administeredAt).toLocaleString()}</small></span></div>)}</div>
      {administrationsQuery.error && <p className="error" role="alert">{errorText(administrationsQuery.error)}</p>}
    </section>}
  </>;
}

function EmergencyPage({ api, user }: { api: ClinicalApi; user: ClinicalUser }) {
  const queryClient = useQueryClient();
  const isAdmin = adminRoles.includes(user.role);
  const isIntakeStaff = ["DOCTOR", "NURSE", "RECEPTIONIST"].includes(user.role);
  const isClinician = user.role === "DOCTOR" || user.role === "NURSE";
  const patientsQuery = usePatients(api, isIntakeStaff);
  const categoriesQuery = useQuery<Array<{ id: string; code: string; label: string; priority: number; active: boolean }>>({
    queryKey: ["triage-categories"],
    queryFn: () => api.get(`/emergency/triage-categories${isAdmin ? "?includeInactive=true" : ""}`).then((response) => response.data.data),
  });
  const [patientId, setPatientId] = React.useState("");
  const [chiefComplaint, setChiefComplaint] = React.useState("");
  const [newCategoryCode, setNewCategoryCode] = React.useState("");
  const [newCategoryLabel, setNewCategoryLabel] = React.useState("");
  const [newCategoryPriority, setNewCategoryPriority] = React.useState("");
  const [triageSelections, setTriageSelections] = React.useState<Record<string, string>>({});
  const [triageNotes, setTriageNotes] = React.useState<Record<string, string>>({});
  const [statusSelections, setStatusSelections] = React.useState<Record<string, string>>({});
  const [admissionSelections, setAdmissionSelections] = React.useState<Record<string, string>>({});
  const visitsQuery = useQuery<EmergencyVisit[]>({
    queryKey: ["emergency-visits"],
    queryFn: () => api.get("/emergency/visits").then((response) => response.data.data as EmergencyVisit[]),
    enabled: isIntakeStaff,
  });
  const admissionsQuery = useQuery<Admission[]>({
    queryKey: ["emergency-admissions"],
    queryFn: () => api.get("/admissions", { params: { status: "ACTIVE", limit: 100 } }).then((response) => response.data.data.items as Admission[]),
    enabled: isClinician,
  });
  const refreshCategories = () => queryClient.invalidateQueries({ queryKey: ["triage-categories"] });
  const refreshVisits = () => queryClient.invalidateQueries({ queryKey: ["emergency-visits"] });
  const createCategory = useMutation({
    mutationFn: () => api.post("/emergency/triage-categories", { code: newCategoryCode, label: newCategoryLabel, priority: Number(newCategoryPriority) }),
    onSuccess: () => { setNewCategoryCode(""); setNewCategoryLabel(""); setNewCategoryPriority(""); void refreshCategories(); },
  });
  const updateCategory = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/emergency/triage-categories/${id}`, { active }),
    onSuccess: () => void refreshCategories(),
  });
  const createVisit = useMutation({
    mutationFn: () => {
      const selectedCategory = triageSelections.new;
      return api.post("/emergency/visits", {
        patientId,
        chiefComplaint,
        ...(isClinician && selectedCategory ? { triageCategoryId: selectedCategory, triageNotes: triageNotes.new || undefined } : {}),
      });
    },
    onSuccess: () => { setChiefComplaint(""); setTriageSelections((value) => ({ ...value, new: "" })); void refreshVisits(); },
  });
  const triage = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) => api.patch(`/emergency/visits/${id}/triage`, {
      triageCategoryId: categoryId,
      triageNotes: triageNotes[id] || undefined,
    }),
    onSuccess: () => void refreshVisits(),
  });
  const updateStatus = useMutation({
    mutationFn: ({ id, status, admissionId }: { id: string; status: string; admissionId?: string }) => api.patch(`/emergency/visits/${id}/status`, { status, admissionId }),
    onSuccess: () => void refreshVisits(),
  });
  return <><p className="eyebrow">EMERGENCY AND TRIAGE</p><div className="page-head"><div><h1>{isAdmin ? "Emergency configuration" : "Emergency visits"}</h1><p className="muted">Triage categories are configurable; authorized clinicians assign them manually. No automated acuity or treatment recommendations are generated.</p></div></div>
    {isAdmin && <section className="panel phase2-panel"><h2>Configure triage categories</h2>
      <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); createCategory.mutate(); }}>
        <label>Category code<input value={newCategoryCode} onChange={(event) => setNewCategoryCode(event.target.value)} pattern="[A-Za-z0-9_-]+" required maxLength={40}/></label>
        <label>Category label<input value={newCategoryLabel} onChange={(event) => setNewCategoryLabel(event.target.value)} maxLength={120} required/></label>
        <label>Display priority<input type="number" min="1" max="100000" value={newCategoryPriority} onChange={(event) => setNewCategoryPriority(event.target.value)} required/></label>
        <button className="primary" disabled={createCategory.isPending}>{createCategory.isPending ? "Saving…" : "Add category"}</button>
      </form>
      {createCategory.error && <p className="error" role="alert">{errorText(createCategory.error)}</p>}
      <div className="clinical-list">{(categoriesQuery.data ?? []).map((category) => <div className="clinical-row" key={category.id}><span><strong>{category.label}</strong><small>{category.code} · configured priority {category.priority}{category.active ? "" : " · inactive"}</small></span><button className="secondary" disabled={updateCategory.isPending} onClick={() => updateCategory.mutate({ id: category.id, active: !category.active })}>{category.active ? "Deactivate" : "Reactivate"}</button></div>)}</div>
      {updateCategory.error && <p className="error" role="alert">{errorText(updateCategory.error)}</p>}
    </section>}
    {isIntakeStaff && <section className="panel phase2-panel"><h2>Register emergency visit</h2>
      <form className="clinical-form-grid" onSubmit={(event) => { event.preventDefault(); createVisit.mutate(); }}>
        <PatientPicker patients={patientsQuery.data ?? []} value={patientId} onChange={setPatientId}/>
        <label>Chief complaint<input value={chiefComplaint} onChange={(event) => setChiefComplaint(event.target.value)} maxLength={2000} required/></label>
        {isClinician && <label>Manual triage category (optional)<select value={triageSelections.new ?? ""} onChange={(event) => setTriageSelections((value) => ({ ...value, new: event.target.value }))}><option value="">Not triaged yet</option>{(categoriesQuery.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>}
        {isClinician && <label>Triage notes (optional)<input value={triageNotes.new ?? ""} onChange={(event) => setTriageNotes((value) => ({ ...value, new: event.target.value }))} maxLength={4000}/></label>}
        <button className="primary" disabled={!patientId || createVisit.isPending}>{createVisit.isPending ? "Saving…" : "Register visit"}</button>
      </form>
      {createVisit.error && <p className="error" role="alert">{errorText(createVisit.error)}</p>}
    </section>}
    {isIntakeStaff && <section className="panel phase2-panel"><h2>Emergency queue</h2>
      {visitsQuery.isLoading && <p className="muted">Loading visits…</p>}
      {visitsQuery.error && <p className="error" role="alert">{errorText(visitsQuery.error)}</p>}
      <div className="clinical-list">{(visitsQuery.data ?? []).map((visit) => {
        const availableStatuses = visit.status === "WAITING" ? ["IN_PROGRESS", "TRANSFERRED"] : visit.status === "IN_PROGRESS" ? ["ADMITTED", "DISCHARGED", "TRANSFERRED"] : [];
        return <article className="clinical-record" key={visit.id}>
          <div className="clinical-record-head"><div><strong>{visit.patient.patientNumber} · {visit.patient.firstName} {visit.patient.lastName}</strong><small>{visit.chiefComplaint} · {visit.status}</small></div><span className="badge">{visit.triageCategory?.label ?? "UNTRIAGED"}</span></div>
          {visit.triageNotes && <p>{visit.triageNotes}</p>}
          {isClinician && availableStatuses.length > 0 && <div className="clinical-form-grid">
            <label>Manual triage category<select value={triageSelections[visit.id] ?? ""} onChange={(event) => setTriageSelections((value) => ({ ...value, [visit.id]: event.target.value }))}><option value="">Select a configured category</option>{(categoriesQuery.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
            <label>Clinical triage notes<input value={triageNotes[visit.id] ?? ""} onChange={(event) => setTriageNotes((value) => ({ ...value, [visit.id]: event.target.value }))} maxLength={4000}/></label>
            <button className="secondary" disabled={!triageSelections[visit.id] || triage.isPending} onClick={() => triage.mutate({ id: visit.id, categoryId: triageSelections[visit.id] })}>Record triage</button>
            <label>Visit status<select value={statusSelections[visit.id] ?? ""} onChange={(event) => setStatusSelections((value) => ({ ...value, [visit.id]: event.target.value }))}><option value="">Select status transition</option>{availableStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            {statusSelections[visit.id] === "ADMITTED" && <label>Active admission<select value={admissionSelections[visit.id] ?? ""} onChange={(event) => setAdmissionSelections((value) => ({ ...value, [visit.id]: event.target.value }))}><option value="">Select an active admission</option>{(admissionsQuery.data ?? []).filter((admission) => admission.patientId === visit.patientId && admission.status === "ACTIVE").map((admission) => <option key={admission.id} value={admission.id}>{admission.id}</option>)}</select></label>}
            <button className="primary" disabled={!statusSelections[visit.id] || (statusSelections[visit.id] === "ADMITTED" && !admissionSelections[visit.id]) || updateStatus.isPending} onClick={() => updateStatus.mutate({ id: visit.id, status: statusSelections[visit.id], admissionId: admissionSelections[visit.id] })}>Update visit</button>
          </div>}
        </article>;
      })}</div>
      {(triage.error || updateStatus.error || admissionsQuery.error) && <p className="error" role="alert">{errorText(triage.error ?? updateStatus.error ?? admissionsQuery.error)}</p>}
    </section>}
  </>;
}

export default function ClinicalWorkspace({ page, api, user }: { page: string; api: ClinicalApi; user: ClinicalUser }) {
  if (page === "Clinical Records") return <ClinicalRecordsPage api={api} user={user}/>;
  if (page === "Prescriptions") return <PrescriptionsPage api={api} user={user}/>;
  if (page === "Nursing") return <NursingPage api={api} user={user}/>;
  return <EmergencyPage api={api} user={user}/>;
}

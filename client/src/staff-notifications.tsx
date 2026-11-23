import type { AxiosInstance } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./operations.css";

type StaffAlert = { id: string; title: string; message: string; category: string; readAt: string | null; createdAt: string };

function requestError(error: unknown) {
  if (typeof error === "object" && error !== null && "response" in error) {
    return String((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? "The request failed.");
  }
  return "The request failed.";
}

export default function StaffNotifications({ api }: { api: AxiosInstance }) {
  const client = useQueryClient();
  const alerts = useQuery<{ items: StaffAlert[]; unreadCount: number }>({
    queryKey: ["staff-alerts"],
    queryFn: () => api.get("/notifications/staff").then((response) => response.data.data),
    refetchInterval: 15_000,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api.patch(`/notifications/staff/${id}/read`, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ["staff-alerts"] }),
  });
  return <>
    <p className="eyebrow">STAFF COMMUNICATION</p>
    <div className="page-head"><div><h1>Staff alerts</h1><p className="muted">Operational alerts for your account.</p></div><span className="badge">{alerts.data?.unreadCount ?? 0} unread</span></div>
    {alerts.isLoading && <p className="muted">Loading staff alerts…</p>}
    {alerts.isError && <p className="error" role="alert">{requestError(alerts.error)}</p>}
    {markRead.error && <p className="error" role="alert">{requestError(markRead.error)}</p>}
    <section className="panel phase5-alert-list">
      {alerts.data?.items.length ? alerts.data.items.map((item) => <article className={`phase5-alert ${item.readAt ? "" : "unread"}`} key={item.id}>
        <div><strong>{item.title}</strong><small>{item.category} · {new Date(item.createdAt).toLocaleString()}</small><p>{item.message}</p></div>
        {!item.readAt && <button className="secondary" disabled={markRead.isPending} onClick={() => markRead.mutate(item.id)}>Mark read</button>}
      </article>) : !alerts.isLoading && !alerts.isError ? <p className="muted">No staff alerts yet.</p> : null}
    </section>
  </>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { api } from "@/src/api/client";
import { AdminPage } from "@/src/components/AdminPage";
import { Avatar, Badge, Button, Card, Chip, EmptyState, ErrorState, LoadingState } from "@/src/components/ui";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { spacing, type } from "@/src/theme/tokens";

type LeadActivity = { summary?: string; event_type?: string; actor_name?: string; payload?: { response?: string; outcome?: string }; id?: string; action?: string; description?: string; response?: string; created_at?: string; timestamp?: string };
type WorkerLead = { id: string; customer_name: string; floor_id: string; status: string; contact_attempts: number; call_attempts: number; last_contacted_at?: string; latest_response?: string; latest_update?: string; activity: LeadActivity[] };
type Worker = { user_id: string; user_name: string; assigned_leads: number; contacts_made: number; calls_made: number; completed_leads: number; leads: WorkerLead[] };
type TeamReport = { workers: Worker[]; has_more: boolean; page: number; page_size: number; activity_truncated?: boolean };

export default function TeamAssign() {
  const { staff } = useAuth();
  const { floors } = useFloorAccess();
  const [floorIds, setFloorIds] = useState<string[]>([]);
  const [report, setReport] = useState<TeamReport | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const generation = useRef(0);
  const allowed = staff?.role === "owner";
  const key = [...floorIds].sort().join(",");
  const load = useCallback((page = 1) => {
    if (!allowed || !floors.length) return;
    const version = ++generation.current;
    setError(false); setReport(null); setExpanded(null);
    const requested = key || floors.map(f => f.id).join(",");
    void api.get<TeamReport>(`/followups/team-assign?floor_ids=${encodeURIComponent(requested)}&page=${page}&page_size=50`).then(result => { if (version === generation.current) setReport(result); }).catch(() => { if (version === generation.current) setError(true); });
  }, [allowed, floors, key]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load]);
  return <AdminPage title="Team assign" overline="TEAM" subtitle="Assigned leads, contacts, calls, completed work and customer responses for every worker.">
    {!allowed ? <EmptyState icon="lock" title="Owner access only" subtitle="The owner can review team assignments and lead activity here." /> : <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Chip label="All floors" active={!floorIds.length} onPress={() => setFloorIds([])} />
        {floors.map(f => <Chip key={f.id} label={f.name} active={floorIds.includes(f.id)} onPress={() => setFloorIds(current => current.includes(f.id) ? current.filter(id => id !== f.id) : [...current, f.id])} />)}
        <Button label="Refresh" icon="refresh-cw" variant="secondary" onPress={() => load()} />
      </View>
      {error ? <ErrorState title="Couldn't load team activity" onRetry={() => load()} /> : !report ? <LoadingState label="Loading team activity…" /> : !report.workers.length ? <EmptyState icon="users" title="No assigned leads" subtitle="Assign people from the Interested floors and Assign team options on each follow-up." /> : <View style={{ gap: spacing.md }}>
        {report.activity_truncated ? <Text style={type.caption}>Showing the most recent activity for this page. Worker totals include all matching leads and contacts.</Text> : null}
        {report.workers.map(worker => <Card key={worker.user_id} testID={`team-worker-${worker.user_id}`}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}><Avatar name={worker.user_name} size={36} /><Text style={type.titleSm}>{worker.user_name}</Text></View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginVertical: spacing.md }}>
            <Badge label={`${worker.assigned_leads} leads assigned`} tone="brand" />
            <Badge label={`${worker.contacts_made} contacts`} tone="neutral" />
            <Badge label={`${worker.calls_made} calls`} tone="neutral" />
            <Badge label={`${worker.completed_leads} completed`} tone="success" />
          </View>
          {worker.leads.map(lead => {
            const leadKey = `${worker.user_id}:${lead.id}`;
            return <View key={lead.id} style={{ paddingVertical: spacing.sm, gap: spacing.xs }}>
              <Pressable accessibilityRole="button" onPress={() => setExpanded(current => current === leadKey ? null : leadKey)} testID={`team-lead-${lead.id}`}>
                <Text style={type.bodyStrong}>{lead.customer_name} · {floors.find(f => f.id === lead.floor_id)?.name || lead.floor_id}</Text>
                <Text style={type.caption}>{lead.status} · Lead total: {lead.contact_attempts} contacts · {lead.call_attempts} calls</Text>
                <Text style={type.bodySm}>Latest response: {lead.latest_response || "No response recorded"}</Text>
                <Text style={type.caption}>Latest update: {lead.latest_update || lead.last_contacted_at || "No activity recorded"}</Text>
              </Pressable>
              {expanded === leadKey ? <View style={{ paddingLeft: spacing.md, gap: spacing.sm }}>{(lead.activity || []).length ? lead.activity.map((event, index) => <View key={event.id || index}><Text style={type.bodySm}>{event.summary || event.description || event.event_type || event.action || "Lead activity"}{event.actor_name ? ` · ${event.actor_name}` : ""}{event.payload?.response || event.response ? ` · ${event.payload?.response || event.response}` : ""}</Text><Text style={type.caption}>{event.created_at || event.timestamp || ""}</Text></View>) : <Text style={type.caption}>No activity yet</Text>}</View> : null}
            </View>;
          })}
        </Card>)}
        <View style={{ flexDirection: "row", gap: spacing.sm }}>{report.page > 1 ? <Button label="Previous page" variant="secondary" onPress={() => load(report.page - 1)} /> : null}{report.has_more ? <Button label="Next page" variant="secondary" onPress={() => load(report.page + 1)} /> : null}</View>
      </View>}
    </>}
  </AdminPage>;
}

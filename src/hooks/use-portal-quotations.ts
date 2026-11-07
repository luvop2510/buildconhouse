import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";

export type PortalQuotation = {
  id: string; number: string; status: string; grand_total: number;
  created_at: string; valid_until?: string; item_count: number; revision_count: number;
};
type QuotationPage = { items: PortalQuotation[]; total: number; has_more: boolean };

/** Portal lists load one summary page, keeping editable documents fresh. */
export function usePortalQuotations(limit: number, page = 0, query = "") {
  const { customer } = useAuth();
  const scope = useMemo(() => ({ customerId: customer?.id, limit, page, query }), [customer?.id, limit, page, query]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: typeof scope; data: QuotationPage | null; loading: boolean; error: boolean }>({ scope, data: null, loading: true, error: false });
  const reload = useCallback(async () => {
    if (!mounted.current || activeScope.current !== scope || !scope.customerId) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = () => mounted.current && activeScope.current === scope && !controller.signal.aborted;
    setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null, loading: true, error: false }));
    try {
      const params = new URLSearchParams({ limit: String(scope.limit), skip: String(scope.page * scope.limit) });
      if (scope.query) params.set("q", scope.query);
      const data = await api.get<QuotationPage>(`/portal/quotations/page?${params}`, { signal: controller.signal, cacheMs: 0 });
      if (current()) setState({ scope, data, loading: false, error: false });
    } catch {
      if (current()) setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null, loading: false, error: true }));
    }
  }, [scope]);
  useEffect(() => {
    void reload();
    return () => { pending.current?.abort(); };
  }, [reload]);
  const data = state.scope === scope ? state.data : null;
  const loading = state.scope !== scope || state.loading;
  return { data, loading, error: state.scope === scope && state.error, refreshing: loading && !!data, reload };
}

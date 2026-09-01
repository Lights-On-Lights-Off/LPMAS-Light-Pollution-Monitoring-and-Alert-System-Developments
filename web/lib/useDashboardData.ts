"use client";
import { useEffect, useState } from "react";
import { getDashboardSummary, type DashboardSummary } from "./api";

export function useDashboardData() {
  const [data, setData] = useState<DashboardSummary>({ phase: null, readings: [], incidents: [], generatedAt: new Date().toISOString() });
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = () => getDashboardSummary()
      .then(v => {
        if (active) {
          setData(v);
          setDemo(false);
          setError(null);
          setLoading(false);
        }
      })
      .catch(err => {
        if (active) {
          setDemo(false);
          setError(err instanceof Error ? err.message : "Unable to load live readings");
          setLoading(false);
        }
      });

    refresh();
    const interval = setInterval(refresh, 5_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return { data, demo, loading, error };
}
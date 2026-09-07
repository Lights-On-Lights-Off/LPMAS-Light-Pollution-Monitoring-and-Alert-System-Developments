"use client";
import { useEffect, useState } from "react";
import { getDashboardSummary, type DashboardSummary } from "./api";

const EMPTY_DATA: DashboardSummary = { phase: null, readings: [], incidents: [], generatedAt: new Date(0).toISOString() };

export function useDashboardData() {
  const [data, setData] = useState<DashboardSummary>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = () => getDashboardSummary()
      .then(value => {
        if (!active) return;
        setData(value);
        setError(null);
        setLoading(false);
      })
      .catch(err => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to load live sensor data");
        setLoading(false);
      });

    refresh();
    const interval = setInterval(refresh, 5_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return { data, loading, error };
}
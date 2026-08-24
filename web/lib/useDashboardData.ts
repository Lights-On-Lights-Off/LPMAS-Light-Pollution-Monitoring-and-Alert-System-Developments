"use client";
import { useEffect, useState } from "react";
import { getDashboardSummary, type DashboardSummary } from "./api";
import { demoData } from "./demo";

export function useDashboardData() {
  const [data, setData] = useState<DashboardSummary>(demoData);
  const [demo, setDemo] = useState(true);

  useEffect(() => {
    let active = true;
    const refresh = () => getDashboardSummary()
      .then(v => { if (active) { setData(v); setDemo(false); } })
      .catch(() => { if (active) setDemo(true); });

    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  return { data, demo };
}

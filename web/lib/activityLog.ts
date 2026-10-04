"use client";

import { supabase } from "./supabase";
import { activityBrowser, activityPage } from "./activity-context";

export type ActivityDetails = Record<string, unknown>;

export async function logActivity(action: string, resource?: string, resourceId?: string, details?: ActivityDetails) {
  if (!supabase) return { data: null, error: new Error("Supabase is not configured") };

  const { data, error } = await supabase.rpc("log_activity", {
    p_action: action,
    p_resource: resource ?? null,
    p_resource_id: resourceId ?? null,
    p_details: details ?? null,
    p_page: typeof window === "undefined" ? null : activityPage(window.location.pathname, window.location.search),
    p_browser: typeof navigator === "undefined" ? null : activityBrowser(navigator.userAgent)
  });

  if (error) {
    console.error("[activityLog] message:", error.message);
    console.error("[activityLog] details:", error.details);
    console.error("[activityLog] hint:", error.hint);
    console.error("[activityLog] code:", error.code);
  }

  return { data, error };
}

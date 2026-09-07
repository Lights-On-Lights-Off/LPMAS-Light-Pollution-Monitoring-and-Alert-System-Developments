"use client";

import { supabase } from "./supabase";

export type ActivityDetails = Record<string, unknown>;

export async function logActivity(action: string, resource?: string, resourceId?: string, details?: ActivityDetails) {
  if (!supabase) return { data: null, error: new Error("Supabase is not configured") };

  const { data, error } = await supabase.rpc("log_activity", {
    p_action: action,
    p_resource: resource ?? null,
    p_resource_id: resourceId ?? null,
    p_details: details ?? null
  });

  if (error) {
    console.error("[activityLog] message:", error.message);
    console.error("[activityLog] details:", error.details);
    console.error("[activityLog] hint:", error.hint);
    console.error("[activityLog] code:", error.code);
  }

  return { data, error };
}
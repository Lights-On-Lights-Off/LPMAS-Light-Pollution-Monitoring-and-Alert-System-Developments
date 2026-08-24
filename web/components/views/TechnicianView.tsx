"use client";
import { CloudSun, Radio } from "lucide-react";
import { Card, Badge } from "../ui";
import { mockKPIs } from "@/lib/mockData";

export function TechnicianView({ section }: { section: string }) {
  return <div className="space-y-6 p-6 md:p-8">
    <div>
      <h1 className="text-2xl font-bold text-metal-50">Greenhouse status</h1>
      <p className="mt-1 text-sm text-metal-400">Read-only monitoring view.</p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="flex items-center gap-4">
        <span className="rounded-xl bg-leaf-500/10 p-3 text-leaf-500"><CloudSun /></span>
        <div><p className="text-sm text-metal-400">Current phase</p><p className="mt-1 font-bold text-metal-50">{mockKPIs.currentPhase}</p></div>
      </Card>
      <Card className="flex items-center gap-4">
        <span className="rounded-xl bg-leaf-500/10 p-3 text-leaf-500"><Radio /></span>
        <div><p className="text-sm text-metal-400">Sensors online</p><p className="mt-1 font-bold text-metal-50">{mockKPIs.sensorsOnline} of 3</p></div>
      </Card>
    </div>
    <Card>
      <p className="font-bold text-metal-50">Greenhouse 3</p>
      <p className="mt-1 text-sm text-metal-400">Chrysanthemum · Illumination phase</p>
      <Badge tone="green">All sensors reporting</Badge>
    </Card>
  </div>;
}

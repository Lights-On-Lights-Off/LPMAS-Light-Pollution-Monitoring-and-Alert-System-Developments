"use client";

import { useEffect, useState } from "react";

type Props = {
  data: string[][];
  options: Record<string, unknown>;
  className?: string;
};

export default function DataTableClient({ data, options, className }: Props) {
  const [Component, setComponent] = useState<any>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const [{ default: DataTable }, { default: DT }] = await Promise.all([
        import("datatables.net-react"),
        import("datatables.net-dt")
      ]);

      DataTable.use(DT);

      if (active) setComponent(() => DataTable);
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  if (!Component) return <div className="grid min-h-56 place-items-center text-sm text-[var(--muted-foreground)]">Loading activity table...</div>;

  return <div className="w-full [&_.dt-search]:mb-4 [&_.dt-search]:flex [&_.dt-search]:items-center [&_.dt-search]:gap-2 [&_.dt-search_label]:text-sm [&_.dt-search_label]:text-[var(--muted-foreground)] [&_.dt-search_input]:!ml-0 [&_.dt-search_input]:!h-9 [&_.dt-search_input]:!w-64 [&_.dt-search_input]:!rounded-xl [&_.dt-search_input]:!border [&_.dt-search_input]:!border-white/10 [&_.dt-search_input]:!bg-white/[0.04] [&_.dt-search_input]:!px-3 [&_.dt-search_input]:!text-sm [&_.dt-search_input]:!text-[var(--foreground)] [&_.dt-search_input]:!outline-none [&_.dt-search_input]:!backdrop-blur-xl [&_.dt-search_input]:focus:!border-[color-mix(in_srgb,var(--accent)_40%,transparent)] [&_.dt-search_input]:focus:!bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]">
    <Component data={data} className={className} options={options} />
  </div>;
}
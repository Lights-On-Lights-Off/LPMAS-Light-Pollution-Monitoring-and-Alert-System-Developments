// Minimal client-side CSV export — no server round-trip, just serializes
// whatever rows are currently rendered in a table and triggers a download.
export function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (!rows.length) return;

  const headers = Object.keys(rows[0]);
  const escape = (value: string | number) => {
    const str = String(value ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [
    headers.join(","),
    ...rows.map(row => headers.map(h => escape(row[h])).join(","))
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

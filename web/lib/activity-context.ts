/** Keep the dashboard section, without recording OAuth codes or other URL secrets. */
export function activityPage(pathname: string, search: string): string {
  if (pathname !== "/dashboard") return pathname;
  const section = new URLSearchParams(search).get("section");
  const sections = ["overview", "greenhouses", "activity-logs", "recycle-bin", "team", "system-settings", "appearance"];
  return `${pathname}?section=${section && sections.includes(section) ? section : "overview"}`;
}

export function activityBrowser(userAgent: string): string | null {
  // Chromium browsers also advertise Chrome/Safari; iOS browsers advertise Safari.
  const browsers: [string, RegExp][] = [
    ["Edge", /(?:EdgA|EdgiOS|Edg)\/([\d.]+)/],
    ["Opera", /(?:OPR|OPiOS)\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari\//],
  ];
  for (const [name, pattern] of browsers) {
    const match = userAgent.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return userAgent.trim() ? "Unknown browser" : null;
}

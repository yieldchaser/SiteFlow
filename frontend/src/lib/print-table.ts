// Printable table documents built in the browser: report exports and the
// team schedule. The browser's own "Save as PDF" turns them into a PDF.
import { formatDate, formatDateTime } from "@/lib/siteflow";

// Words in a column name that mean the values are rupees.
const MONEY_WORDS = /amount|inr|rate|cost|balance|credit|debit|sales|revenue|expense|profit|budget|deduction|received|due$/i;
// Columns that hold numbers that are labels, not quantities.
const LABEL_WORDS = /^#$|no\.?$|number|id$|phone|contact|reference/i;

function escapeHtmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// One printable layout for "PDF" (browser print, Save as PDF) and "HTML":
// light page, A4, landscape when the report is wide, header row repeated on
// every page, numbers right-aligned in Indian grouping, dates as 09 Nov 2026.
export function printableReportHtml(title: string, headers: string[], rows: unknown[][], autoPrint: boolean): string {
  const wide = headers.length > 8;
  const numeric = headers.map((h, c) =>
    !LABEL_WORDS.test(h) && rows.length > 0 &&
    rows.every(r => r[c] === "" || r[c] === null || r[c] === undefined || (r[c] !== "" && !isNaN(Number(r[c]))))
    && rows.some(r => r[c] !== "" && r[c] !== null && r[c] !== undefined)
  );
  const cell = (value: unknown, c: number): string => {
    if (value === null || value === undefined || value === "") return "";
    if (numeric[c]) {
      const n = Number(value);
      const money = MONEY_WORDS.test(headers[c]);
      return n.toLocaleString("en-IN", money
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumFractionDigits: 3 });
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    return String(value);
  };
  const generated = formatDateTime(new Date());
  const safeTitle = escapeHtmlText(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle} - ${escapeHtmlText(formatDate(new Date()))}</title>
<style>
  @page { size: A4 ${wide ? "landscape" : "portrait"}; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; background: #ffffff; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #6b7280; font-size: 11px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: ${wide ? "9px" : "11px"}; }
  thead { display: table-header-group; }
  th { background: #f3f4f6; font-weight: 600; text-align: left; border-bottom: 1.5px solid #9ca3af; }
  th, td { padding: ${wide ? "4px 5px" : "6px 8px"}; vertical-align: top; }
  td { border-bottom: 1px solid #e5e7eb; }
  tr { page-break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .empty { color: #6b7280; padding: 16px 0; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<p class="meta">${rows.length} ${rows.length === 1 ? "row" : "rows"} &middot; Generated ${escapeHtmlText(generated)}</p>
${rows.length === 0 ? '<p class="empty">No records for the chosen filters.</p>' : `<table>
<thead><tr>${headers.map((h, c) => `<th${numeric[c] ? ' class="num"' : ""}>${escapeHtmlText(h)}</th>`).join("")}</tr></thead>
<tbody>
${rows.map(r => `<tr>${r.map((v, c) => `<td${numeric[c] ? ' class="num"' : ""}>${escapeHtmlText(cell(v, c))}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`}
${autoPrint ? "<script>window.onload = function () { window.print(); };</script>" : ""}
</body>
</html>`;
}

// Opens the document in a new tab, which prints itself on load. Returns
// false when a popup blocker stopped the tab from opening.
export function openPrintWindow(html: string): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

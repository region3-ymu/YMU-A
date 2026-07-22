"use client";

// Client-side PDF export via @react-pdf/renderer (brief-specified, not a
// dependency-minimalism exception like Phase 7's web-push: rendering a
// layout to PDF from scratch is exactly the kind of thing not worth
// hand-rolling). Rendering happens entirely in the browser from data
// already loaded on the page — no extra fetch, no server PDF renderer.

import { Document, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import type { PeriodSummary } from "@/lib/reports/types";

export type ReportPdfSection = {
  teacherName: string;
  rows: PeriodSummary[];
};

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: "Helvetica" },
  title: { fontSize: 16, marginBottom: 4, fontFamily: "Helvetica-Bold" },
  subtitle: { fontSize: 10, marginBottom: 16, color: "#555" },
  section: { marginBottom: 18 },
  sectionHeading: { fontSize: 12, marginBottom: 6, fontFamily: "Helvetica-Bold" },
  table: { display: "flex", width: "100%" },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#ddd", paddingVertical: 3 },
  headerRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#000", paddingVertical: 3 },
  cell: { flex: 1 },
  cellWide: { flex: 1.6 },
  empty: { color: "#777", marginBottom: 12 },
});

function SectionTable({ rows }: { rows: PeriodSummary[] }) {
  if (rows.length === 0) {
    return <Text style={styles.empty}>No classes in range.</Text>;
  }
  return (
    <View style={styles.table}>
      <View style={styles.headerRow}>
        <Text style={styles.cellWide}>Period</Text>
        <Text style={styles.cell}>Hours</Text>
        <Text style={styles.cell}>On time</Text>
        <Text style={styles.cell}>Late</Text>
        <Text style={styles.cell}>Missed</Text>
        <Text style={styles.cell}>Rate %</Text>
      </View>
      {rows.map((row) => (
        <View style={styles.row} key={row.periodKey}>
          <Text style={styles.cellWide}>{row.periodLabel} ({row.periodStart})</Text>
          <Text style={styles.cell}>{row.hoursWorked.toFixed(2)}</Text>
          <Text style={styles.cell}>{row.onTimeCount}</Text>
          <Text style={styles.cell}>{row.lateCount}</Text>
          <Text style={styles.cell}>{row.missedCount}</Text>
          <Text style={styles.cell}>{row.attendanceRatePct ?? "—"}</Text>
        </View>
      ))}
    </View>
  );
}

export function ReportPdfDocument({
  title,
  subtitle,
  sections,
}: {
  title: string;
  subtitle: string;
  sections: ReportPdfSection[];
}) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {sections.map((section) => (
          <View style={styles.section} key={section.teacherName} wrap={false}>
            <Text style={styles.sectionHeading}>{section.teacherName}</Text>
            <SectionTable rows={section.rows} />
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function downloadReportPdf(opts: {
  title: string;
  subtitle: string;
  sections: ReportPdfSection[];
  filename: string;
}) {
  const blob = await pdf(
    <ReportPdfDocument title={opts.title} subtitle={opts.subtitle} sections={opts.sections} />,
  ).toBlob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = opts.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

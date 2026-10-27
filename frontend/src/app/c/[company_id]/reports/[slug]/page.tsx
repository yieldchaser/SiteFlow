"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getApiHost } from "@/lib/api";
import { authHeaders, formatDate, formatDateTime } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { isMissingOrDemoTenant, redirectToLogin } from "@/lib/company-guard";
// R2-755: shared CSV guard, so this export cannot drift from the other four.
import { csvSafeCell, csvQuote } from "@/lib/csv";

const escapeHtml = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Comprehensive metadata configurations for all 70+ reports
interface FilterConfig {
  label: string;
  type: "select" | "date";
  options?: string[];
}

interface ReportMeta {
  title: string;
  hasDownload: boolean;
  filters: FilterConfig[];
  columns: string[];
}

const REPORT_METADATA: Record<string, ReportMeta> = {
  "company-sales": {
    title: "Company Sales Report",
    hasDownload: true,
    filters: [{ label: "Client Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Invoice Date", type: "date" }, { label: "Sale Type", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }],
    columns: ['Invoice Date', 'Sale Type', 'Client Name', 'Project Name', 'Invoice Number', 'Total Amount', 'Retention Amount', 'Due Date', 'Payment Status']
  },
  "sales-deduction-retention": {
    title: "Sales Deduction / Retention Report",
    hasDownload: false,
    filters: [{ label: "Entry Creation Date", type: "date"  }, { label: "Type", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }],
    columns: ['Amount', 'Project Name', 'Party Name', 'Invoice Number', 'Type', 'Entry Creation Date', 'Due Date']
  },
  "crm-lead-detail": {
    title: "CRM Lead Detail Report",
    hasDownload: false,
    filters: [{ label: "Lead Date", type: "date"  }, { label: "Lead Name", type: "select", options: ["All"] }, { label: "Contact Name", type: "select", options: ["All"] }, { label: "Lead Status", type: "select", options: ["All"] }, { label: "Lead Priority", type: "select", options: ["All"] }, { label: "Lead Category", type: "select", options: ["All"] }],
    columns: ['Lead Date', 'Lead Name', 'Contact Name', 'Contact No.', 'Lead Status', 'Lead Priority', 'Lead Source', 'Lead Category', 'Lead Company', 'Email', 'Budget', 'Followup Date', 'Expected Closure Date', 'Remark', 'Assignees']
  },
  "lead-status-funnel": {
    title: "Lead Status Funnel Report",
    hasDownload: false,
    filters: [{ label: "Lead Date", type: "date"  }, { label: "Lead Status", type: "select", options: ["All"] }, { label: "Lead Source", type: "select", options: ["All"] }, { label: "Assignees", type: "select", options: ["All"] }],
    columns: ['Stage', 'Lead Count', 'Conversion Rate (%)']
  },
  "project-wise-sales-summary": {
    title: "Project Wise Sales Summary",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'No. of Invoices', 'Total Sales', 'Retention Amount', 'Post Tax Deduction', 'Net Amount', 'Payment Received', 'Balance Due']
  },
  "company-payments": {
    title: "Company Payments",
    hasDownload: true,
    filters: [{ label: "Payment Date", type: "date"  }, { label: "Creator Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Payment Type", type: "select", options: ["All"] }, { label: "Payment Mode", type: "select", options: ["All"] }, { label: "Cost Code (+ Show more filters)", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Amount', 'Unsettled Amount', 'Net Amount', 'Remark', 'Payment Type', 'Payment Mode', 'Account Name', 'Cost Code', 'Sub Cost Code', 'Category', 'Created Date', 'Reference No.']
  },
  "bank-statement": {
    title: "Bank Statement",
    hasDownload: false,
    filters: [{ label: "Account Name", type: "select", options: ["All"] }, { label: "Account Number", type: "select", options: ["All"] }, { label: "Bank Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Payment Date", type: "date" }],
    columns: ['Account Name', 'Project Name', 'Party Name', 'Payment Date', 'Credit', 'Debit', 'Balance', 'Remarks']
  },
  "project-wise-payment-summary": {
    title: "Project Wise Payment Summary",
    hasDownload: false,
    filters: [{ label: "Payment Date", type: "date"  }, { label: "Project Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Receipts Count', 'Receipts Amount (INR)', 'Unsettled Receipts (INR)', 'Payouts Count', 'Payouts Amount (INR)', 'Unsettled Payouts (INR)', 'Last Transaction Date']
  },
  "project-payment": {
    title: "Project Payment Report",
    hasDownload: false,
    filters: [{ label: "Payment Date", type: "date"  }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Payment Type", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Account Name", type: "select", options: ["All"] }],
    columns: ['Payment Date', 'Project Name', 'Party Name', 'Amount', 'Remark', 'Reference No.', 'Payment Type', 'Payment Mode', 'Account Name', 'Category', 'Cost Code', 'Sub Cost Code', 'Created Date']
  },
  "payment-request": {
    title: "Payment Request Report",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Approval Status", type: "select", options: ["All"] }, { label: "Payment Status", type: "select", options: ["All"] }, { label: "Payment Date", type: "date" }],
    columns: ['Payment Request ID', 'Payment Request No.', 'Project Name', 'Party Name', 'Amount', 'Payment Date', 'Due Date', 'Creator Name', 'Request Type', 'Approval Status', 'Payment Status', 'Remark']
  },
  "task-report": {
    title: "Task Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }, { label: "Progress Date", type: "date" }, { label: "Task Status", type: "select", options: ["All"] }, { label: "Delay Status", type: "select", options: ["All"] }, { label: "Assigned To", type: "select", options: ["All"] }, { label: "Start Date (+ Show more filters)", type: "date" }],
    columns: ['Project Name', 'Task Name', 'Start Date', 'End Date']
  },
  "task-measurement-book": {
    title: "Task Measurement Book",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }, { label: "Progress Date", type: "date" }, { label: "Task Status", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Main Task Name', 'Group Task Name', 'Task Name', 'Progress Date', 'Unit', 'Estimated Quantity', 'Progress Quantity', 'Progress Notes']
  },
  "task-material": {
    title: "Task Material Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Material Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }, { label: "Used Date", type: "date" }],
    columns: ['Project Name', 'Material Name', 'Main Task Name', 'Group Task Name', 'Avg Unit Rate', 'Avg Cost (INR)']
  },
  "todo-report": {
    title: "To Do Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Activity Name", type: "select", options: ["All"] }, { label: "Assigned To", type: "select", options: ["All"] }, { label: "Due Date", type: "date" }, { label: "Status", type: "select", options: ["All"] }, { label: "Related Task", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }],
    columns: ['Activity Name', 'Project Name', 'Status', 'Creation Date', 'Due Date', 'Last Updated Date', 'Assigned To', 'Type', 'Related Task', 'Creator Name', 'Closed Date']
  },
  "task-resource-budget-vs-actual": {
    title: "Task Resource Budget Vs Actual Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Resource Name", type: "select", options: ["All"] }, { label: "Resource Type", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Main Task Name', 'Group Task Name', 'Task Name', 'Task Unit', 'Task Qty', 'Task Progress Qty', 'Resource Name', 'Resource Type', 'Budgeted Rate', 'Avg Unit Cost', 'Unit', 'Qty per Unit', 'Budgeted Qty', 'Pro Rata Budgeted Qty', 'Actual Used Qty', 'Budgeted Amount', 'Pro Rata Budgeted Amount', 'Actual Amount', 'Exceeded Qty', 'Exceeded Amount']
  },
  "site-inspection": {
    title: "Site Inspection Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Inspection Date", type: "date" }, { label: "Inspection Name", type: "select", options: ["All"] }, { label: "Inspection Status", type: "select", options: ["All"] }, { label: "Approval Status", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Inspection Date', 'Inspection Name', 'Inspection Status', 'Inspection Items', 'Inspection Notes', 'Created Date', 'Approval Status']
  },
  "task-revenue-expense": {
    title: "Task Revenue & Expense Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }, { label: "Date", type: "date" }],
    columns: ['Project Name', 'Main Task Name', 'Group Task Name', 'Task Name', 'Progress', 'Unit', 'Revenue (INR)', 'Expense (INR)', 'Net Profit (INR)']
  },
  "task-boq-billed-unbilled": {
    title: "Task BOQ Billed & Unbilled Qty Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Main Task Name', 'Group Task Name', 'Task Name', 'Unit', 'Estimated Qty', 'Progress Qty', '% Complete', 'Task Status', 'Linked BOQ Detail', 'Billed Qty', 'Unbilled Qty']
  },
  "task-attendance": {
    title: "Task Attendance Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Attendance Date", type: "date" }, { label: "Main Task Name", type: "select", options: ["All"] }, { label: "Group Task Name", type: "select", options: ["All"] }, { label: "Task Name", type: "select", options: ["All"] }],
    columns: ['Workforce Name', 'Project Name', 'Attendance Date', 'Attendance Status', 'Work Hours']
  },
  "company-expense": {
    title: "Company Expense Report",
    hasDownload: true,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Expense Date", type: "date" }, { label: "Expense Type", type: "select", options: ["All"] }, { label: "Expense Status", type: "select", options: ["All"] }, { label: "Cost Code", type: "select", options: ["All"] }, { label: "Settlement By", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }, { label: "Due Date (+ Show more filters)", type: "date" }],
    columns: ['Txn Type', 'Project Name', 'Description', 'Party Name', 'Txn Status', 'Base Amount', 'Tax Amount', 'Bill Discount', 'Additional Charges', 'Total Amount', 'Net Amount', 'Paid Amount', 'Unpaid Amount', 'Due Date', 'Settlement By', 'Payment Mode', 'Cost Code', 'Sub Cost Code', 'Notes/Remarks', 'Reference No.', 'Creator Name', 'Approval Status', 'Created Date']
  },
  "cost-code-expense-analysis": {
    title: "Cost Code Expense Analysis",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Expense Date", type: "date" }],
    columns: ['Cost Code', 'Category', 'Total Expense (INR)', 'Bill Count', 'Share (%)']
  },
  "project-wise-expense-summary": {
    title: "Project Wise Expense Summary",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Txn Date", type: "date" }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Due Date", type: "date" }],
    columns: ['Project Name', 'Total Expenses (INR)', 'Paid Amount (INR)', 'Unpaid Amount (INR)', 'Budget Allocation (INR)']
  },
  "all-expense-deduction-retention": {
    title: "All Expense Deduction / Retention Report",
    hasDownload: false,
    filters: [{ label: "Type", type: "select", options: ["All"] }, { label: "Item Name", type: "select", options: ["All"] }, { label: "Date", type: "date" }],
    columns: ['Entry Creation Date', 'Type', 'Item Name', 'Amount', 'Bill Number', 'Expense Type', 'Project Name', 'Party Name', 'Creator Name', 'Due Date']
  },
  "party-ledger": {
    title: "Party Ledger",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Party Type", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Transaction Type", type: "select", options: ["All"] }, { label: "Transaction Date", type: "date" }],
    columns: ['Party Name', 'Party Type', 'Project Name', 'Creator Name', 'Description', 'Cost Code', 'Transaction Type', 'Transaction Date', 'Party Debit', 'Party Credit', 'Balance']
  },
  "all-party-balances": {
    title: "All Party Balances",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Balance Type", type: "select", options: ["All"] }, { label: "Party Type", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Balance Amount', 'Balance Type']
  },
  "project-level-party-balance": {
    title: "Project level Party Balance Report",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Party Type", type: "select", options: ["All"] }, { label: "Balance Type", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Party Type', 'Project Name', 'Salary', 'Material Purchase', 'Other Expense', 'Subcon Amount', 'Site Expense', 'Equipment Expense', 'Debit Note', 'Sales Invoice', 'Net Retention', 'Credit Note', 'Material Sale', 'Material Return', 'Party Received', 'Party Paid', 'Net Balance', 'Balance Type']
  },
  "material-request-item": {
    title: "Material Request Item Report",
    hasDownload: false,
    filters: [{ label: "Material Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Request No.", type: "select", options: ["All"] }, { label: "Status", type: "select", options: ["All"] }, { label: "Request Date", type: "date" }, { label: "Approved or Rejected", type: "select", options: ["All"] }, { label: "Requested by", type: "select", options: ["All"] }],
    columns: ['Request Date', 'Request No.', 'Project Name', 'Material Name', 'Specifications', 'Unit', 'Request Quantity', 'Ordered Quantity', 'Pending Quantity', 'PO No.', 'Requested by', 'Status', 'Approved/Rejected By', 'Request Notes']
  },
  "material-received-used": {
    title: "Material Received & Used Report",
    hasDownload: false,
    filters: [{ label: "Material", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Entry Type", type: "select", options: ["All"] }, { label: "Date", type: "date" }, { label: "Task Name", type: "select", options: ["All"] }, { label: "Challan Number", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Created By", type: "select", options: ["All"] }, { label: "Material Category (+ Show more filters)", type: "select", options: ["All"] }],
    columns: ['Material', 'Project Name', 'Party Name', 'Created By', 'GRN No.', 'Receiving Date', 'Unit', 'Quantity', 'Unit Price with Tax', 'Total Amount', 'PO Number', 'PO Quantity', 'PO Date']
  },
  "material-stock": {
    title: "Material Stock Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Material Name", type: "select", options: ["All"] }, { label: "Material Category", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Material Name', 'Unit', 'Available Stock']
  },
  "unbilled-item": {
    title: "Unbilled Item Report",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Material", type: "select", options: ["All"] }, { label: "Receiving Date", type: "date" }],
    columns: ['Project Name', 'Party Name', 'Material', 'Unit', 'Quantity', 'Receiving Date']
  },
  "po-summary": {
    title: "PO Summary Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Vendor Name", type: "select", options: ["All"] }, { label: "Approval Status", type: "select", options: ["All"] }, { label: "Approved or Rejected", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'PO Creation Date', 'PO Date', 'PO Number', 'Material', 'Amount', 'Tax Amount', 'Total Amount', 'Approval Status']
  },
  "material-received-without-po": {
    title: "Material Received without PO",
    hasDownload: false,
    filters: [{ label: "(none distinctly labeled)", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Party Name', 'Created By', 'Receiving Date', 'Unit', 'Quantity']
  },
  "purchase-order-item": {
    title: "Purchase Order Item Report",
    hasDownload: false,
    filters: [{ label: "PO Number", type: "select", options: ["All"] }, { label: "PO Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Vendor Name", type: "select", options: ["All"] }, { label: "Material Name", type: "select", options: ["All"] }, { label: "Approval Status", type: "select", options: ["All"] }, { label: "Material Category", type: "select", options: ["All"] }, { label: "Item Status", type: "select", options: ["All"] }, { label: "GRN No.", type: "select", options: ["All"] }],
    columns: ['PO Date', 'PO Number', 'Project Name', 'Material Name', 'Unit', 'Unit Price', 'PO Qty', 'PO Received Qty', 'PO Pending Qty', 'Item Status', 'Approval Status']
  },
  "production-material": {
    title: "Production Material Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Production Date", type: "date" }, { label: "Production Material", type: "select", options: ["All"] }, { label: "Raw Material Consumed", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Production Material', 'Unit', 'Quantity', 'Production Date', 'Raw Material Consumed', 'Notes']
  },
  "material-purchase-item": {
    title: "Material Purchase Item Report",
    hasDownload: false,
    filters: [{ label: "Purchase Date", type: "date"  }, { label: "Receiving Date", type: "date"  }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Party GST", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Material", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Party GST', 'Purchase Date', 'Receiving Date', 'Project Name', 'Material', 'Specification', 'Unit', 'Unit Price', 'Quantity', 'Basic Amount', 'Tax', 'Discount', 'Total Amount', 'Material Category', 'PO Number', 'PO Quantity', 'PO Item Rate', 'PO Date', 'PO Total Amount', 'GRN No.', 'Challan Number', 'Reference No.', 'Remark', 'Created By', 'Vehicle Number', 'Expense Status', 'Due Date', 'Expense Amount', 'Expense Paid Amount', 'Unpaid Expense Amount']
  },
  "material-stock-movement": {
    title: "Material Stock Movement Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Date", type: "date" }, { label: "Material Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Material Name', 'UOM', 'Date', 'Opening Qty', 'Stock In', 'Stock Out', 'Closing Qty']
  },
  "dpr": {
    title: "Daily Progress Report",
    hasDownload: true,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "DPR Date", type: "date" }, { label: "Task Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'DPR Date', 'Task Name', 'Progress Qty', 'Workers Count', 'Material Used']
  },
  "item-wise-sales": {
    title: "Item Wise Sales Report",
    hasDownload: true,
    filters: [{ label: "Invoice Date", type: "date" }, { label: "Client Name", type: "select", options: ["All"] }, { label: "Item Name", type: "select", options: ["All"] }],
    columns: ['Client Name', 'Invoice Date', 'Item Name', 'Unit', 'Quantity', 'Item Rate', 'Tax %', 'Total Amount', 'Invoice Created']
  },
  "company-attendance": {
    title: "Company Attendance Report",
    hasDownload: true,
    filters: [{ label: "Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Department", type: "select", options: ["All"] }, { label: "Status", type: "select", options: ["All"] }],
    columns: ['Date', 'Employee Code', 'Employee Name', 'Designation', 'Department', 'Project Name', 'Punch In', 'Punch Out', 'Status', 'Hours Worked', 'Overtime Hours', 'Geofence Status']
  },
  "staff-monthly-salary-slip": {
    title: "Staff Monthly Salary Slip",
    hasDownload: true,
    filters: [{ label: "Month", type: "select", options: ["All"] }, { label: "Employee Name", type: "select", options: ["All"] }, { label: "Department", type: "select", options: ["All"] }],
    columns: ['Month', 'Employee Code', 'Employee Name', 'Designation', 'Department', 'UAN', 'Bank Account No.', 'Days Present', 'Basic Pay', 'HRA', 'Allowances', 'Gross Pay', 'PF Deduction', 'ESI Deduction', 'TDS', 'Total Deductions', 'Net Pay (INR)']
  },
  "staff-muster-roll": {
    title: "Staff Muster Roll",
    hasDownload: true,
    filters: [{ label: "Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Labor Role / Designation", type: "select", options: ["All"] }],
    columns: ['Date', 'Project Name', 'Labor Role / Designation', 'Workers Present', 'Workers Absent', 'Total Workers', 'Hours Worked', 'Overtime Hours', 'Notes']
  },
  "staff-punch-report": {
    title: "Staff Punch Report",
    hasDownload: true,
    filters: [{ label: "Punch Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Punch Type", type: "select", options: ["All"] }, { label: "Face Verified", type: "select", options: ["All"] }],
    columns: ['Punch Time', 'Employee Code', 'Employee Name', 'Project Name', 'Punch Type', 'Face Verified', 'Confidence Score', 'Geofence Status', 'Latitude', 'Longitude']
  },
  "attendance-salary": {
    title: "Attendance & Salary Report",
    hasDownload: false,
    filters: [{ label: "Attendance Period", type: "select", options: ["All"] }, { label: "Custom Date", type: "date" }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Workforce Name", type: "select", options: ["All"] }, { label: "Payroll Type", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Project Name', 'Designation', 'Total Present Days', 'Net Payable (INR)']
  },
  "ot-shift": {
    title: "OT & Shift Report",
    hasDownload: false,
    filters: [{ label: "Attendance Period", type: "select", options: ["All"] }, { label: "Custom Date", type: "date" }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Workforce Name", type: "select", options: ["All"] }, { label: "Payroll Type", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Party Name', 'Designation', 'Shift Hours', 'OT Hours', 'Overtime Earnings (INR)']
  },
  "staff-salary": {
    title: "Staff Salary Report",
    hasDownload: false,
    filters: [{ label: "Date", type: "date"  }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Designation", type: "select", options: ["All"] }, { label: "Payroll Type", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Designation', 'Phone No.', 'Bank Name', 'IFSC Code', 'Account No.', 'Shift', 'OT Hrs', 'Basic/Payable', 'Allowance Amount', 'Late Fine Deduction', 'Net Payable (INR)']
  },
  "equipment-usage-detail": {
    title: "Equipment Usage Detail Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Equipment Name", type: "select", options: ["All"] }, { label: "Vehicle No.", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Ownership Type", type: "select", options: ["All"] }, { label: "Entry Type", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }, { label: "Used Date", type: "date" }],
    columns: ['Project Name', 'Equipment Name', 'Vehicle No.', 'Ownership Type', 'Party Name', 'Used Date', 'Entry Type', 'Unit', 'Qty', 'Start at', 'Stop at', 'Notes', 'Creator Name']
  },
  "fuel-efficiency": {
    title: "Fuel Efficiency Report",
    hasDownload: false,
    filters: [{ label: "Used Date", type: "date"  }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Equipment Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Equipment Name', 'Vehicle No.', 'Party Name', 'Mileage', 'Eqp Unit', 'Active Days Used', 'Fuel Added', 'Fuel Consumed (Actual)', 'Fuel Consumed (Expected)', 'Fuel Variance']
  },
  "daily-based-equipment-used": {
    title: "Daily based Equipment Used Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Equipment Name", type: "select", options: ["All"] }, { label: "Vehicle No.", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Date", type: "date" }],
    columns: ['Project Name', 'Equipment Name', 'Vehicle No.', 'Ownership Type', 'Party Name', 'Measurement Type', 'Usage Unit', 'Date', 'Equipment Used', 'Fuel Added', 'Fuel Adjusted', 'Equipment Reading', 'Remarks', 'Total Trips', 'Total Distance', 'Total Load Carried']
  },
  "equipment-expense-summary": {
    title: "Equipment Expense Summary",
    hasDownload: false,
    filters: [{ label: "Equipment Name", type: "select", options: ["All"] }, { label: "Vehicle No.", type: "select", options: ["All"] }, { label: "Txn Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }],
    columns: ['Equipment Name', 'Vehicle No.', 'Total Running Cost (INR)', 'Fuel Expenses (INR)', 'Maintenance Cost (INR)']
  },
  "equipment-trip": {
    title: "Equipment Trip Report",
    hasDownload: false,
    filters: [{ label: "Vehicle No.", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Date", type: "date" }],
    columns: ['Trip Name', 'Trip Distance', 'Trip Count', 'Load Per Trip', 'Load Unit', 'Total Load', 'Total Distance', 'Created Date']
  },
  "gstr1-sales": {
    title: "Sales (GSTR-1)",
    hasDownload: true,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Invoice Date", type: "date" }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Invoice Type", type: "select", options: ["All"] }, { label: "Party GST", type: "select", options: ["All"] }, { label: "Company GST", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Project Name', 'Invoice Type', 'Invoice Date', 'Invoice Number', 'Invoice Amount', 'Tax Amount', 'CGST', 'SGST', 'IGST', 'UTGST', 'Company GST']
  },
  "gstr2-purchase": {
    title: "Purchase (GSTR-2)",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Expense Type", type: "select", options: ["All"] }, { label: "Expense Date", type: "date" }, { label: "Party Tax No.", type: "select", options: ["All"] }, { label: "Company Tax No.", type: "select", options: ["All"] }],
    columns: ['Party Name', 'Project Name', 'Expense Type', 'Expense Date', 'Expense Amount', 'CGST', 'SGST', 'IGST', 'UTGST']
  },
  "warehouse-stock-movement": {
    title: "Warehouse Stock Movement Report",
    hasDownload: false,
    filters: [{ label: "Material Name", type: "select", options: ["All"] }, { label: "Material Category", type: "select", options: ["All"] }, { label: "Transaction Type", type: "select", options: ["All"] }, { label: "Transaction Date", type: "date" }],
    columns: ['Material Name', 'Material Category', 'Transaction Date', 'Transaction Type', 'Direction', 'Reference ID', 'Unit', 'Opening Qty', 'Stock Movement', 'Closing Qty', 'Stock Value', 'Avg Purchase Price']
  },
  "warehouse-transaction": {
    title: "Warehouse Transaction Report",
    hasDownload: false,
    filters: [{ label: "Transaction Type", type: "select", options: ["All"] }, { label: "Transaction Date", type: "date" }],
    columns: ['Transaction Date', 'Transaction Type', 'Party Name', 'Bill Subtotal', 'Bill GST', 'Bill Discount', 'Bill Additional Charges', 'Total Amount', 'Material Name', 'Description']
  },
  "warehouse-current-stock": {
    title: "Warehouse Current Stock Report",
    hasDownload: false,
    filters: [{ label: "Material Name", type: "select", options: ["All"] }, { label: "Material Category", type: "select", options: ["All"] }],
    columns: ['Material Name', 'Material Category', 'Unit', 'Opening Stock', 'Total In Quantity', 'Total Out Quantity', 'Current Stock', 'Avg Purchase Price', 'Current Stock Value']
  },
  "subcon-workorder-summary": {
    title: "Subcon Workorder Summary Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Subcontractor Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Workorder Name', 'Workorder Date', 'Workorder No.', 'Subcontractor Name', 'Estimated Amount', '% Order Complete', 'Work Done Amount', 'Billed Amount', 'Pending Billed', 'Creator Name', 'Created Date']
  },
  "subcon-measurement-book": {
    title: "Subcon Measurement Book",
    hasDownload: false,
    filters: [{ label: "Progress Date", type: "date"  }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Subcontractor Name", type: "select", options: ["All"] }, { label: "Workorder Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Workorder No.', 'Group', 'Section', 'Item Name', 'Progress Date', 'Unit', 'Estimated Quantity', 'Opening Quantity', 'Number', 'Length', 'Width', 'Height', 'Progress Quantity', 'Closing Quantity', 'Progress Notes']
  },
  "subcon-deduction-retention": {
    title: "Subcon Deduction / Retention Report",
    hasDownload: false,
    filters: [{ label: "Entry Creation Date", type: "date"  }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Type", type: "select", options: ["All"] }],
    columns: ['Item Name', 'Amount', 'Project Name', 'Party Name', 'Invoice Number', 'Creator Name', 'Type', 'Entry Creation Date', 'Due Date']
  },
  "subcon-material-issue": {
    title: "Subcon Material Issue Summary",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Subcon Name", type: "select", options: ["All"] }, { label: "Material Name", type: "select", options: ["All"] }, { label: "Transaction Date", type: "date" }],
    columns: ['Project Name', 'Subcon Name', 'Material Name', 'Avg Unit Price (INR)', 'Total Quantity Issued', 'Total Cost (INR)']
  },
  "project-financial-summary": {
    title: "Project Financial Summary",
    hasDownload: true,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Project Status', 'Project Health', 'Project Budget', 'Total Expense', 'Budget Remaining', 'Total Sales', 'Project Margin', 'Payment In', 'Payment Out', 'Cash Balance']
  },
  "project-operational-summary": {
    title: "Project Operational Summary",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Project Category', 'Project Stage', 'Key Personnel', 'Project Status', 'Project Health', 'Start Date', 'End Date', 'Progress', 'Customer Name']
  },
  "company-transactions": {
    title: "Company Transactions Report",
    hasDownload: false,
    filters: [{ label: "Txn Date", type: "date"  }, { label: "Project Name", type: "select", options: ["All"] }, { label: "Party Name", type: "select", options: ["All"] }, { label: "Txn Type", type: "select", options: ["All"] }, { label: "Transaction Category", type: "select", options: ["All"] }, { label: "Cost Code", type: "select", options: ["All"] }, { label: "Sub Cost Code", type: "select", options: ["All"] }],
    columns: ['Txn Date', 'Txn Type', 'Created Date', 'Creator Name', 'Party Name', 'Cost Code', 'Sub Cost Code', 'Project Name', 'Transaction Category', 'Total Amount', 'Net Amount', 'Paid Amount', 'Unpaid Amount', 'Reference No.', 'Notes/Remarks', 'Description', 'Due Date', 'Payment Mode', 'Approval Status']
  },
  "monthly-pl": {
    title: "Monthly P&L Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Expense Date", type: "date" }, { label: "Expense Type", type: "select", options: ["All"] }],
    columns: ['Month', 'Revenue (INR)', 'Expense (INR)', 'Net P&L (INR)', 'Profit Margin (%)']
  },
  "project-activity-leaderboard": {
    title: "Project Activity Leaderboard",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Activity Date", type: "date" }, { label: "Module", type: "select", options: ["All"] }],
    columns: ['Project Name', 'Progress Count', 'To Do Count', 'Activity Count (leaderboard-style', 'exact labels partly OCR-garbled)']
  },
  "company-user-activity-leaderboard": {
    title: "Company User Activity Leaderboard",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Activity Date", type: "date" }, { label: "Module", type: "select", options: ["All"] }, { label: "Creator Name", type: "select", options: ["All"] }],
    columns: ['Creator Name', 'Role', 'Activity Count', 'Progress Count', 'To Do Count (leaderboard-style', 'exact labels partly OCR-garbled)']
  },
  "party-library": {
    title: "Party Library",
    hasDownload: false,
    filters: [{ label: "Party Name", type: "select", options: ["All"] }, { label: "Party Type", type: "select", options: ["All"] }],
    columns: ['Party Id', 'Party Name', 'Party Type', 'Bank Name', 'Account Name', 'Account Number', 'IFSC Code', 'Tax No.', 'Billing Address', 'Aadhar Card Number', 'PAN Card Number', 'ESI Number', 'PF Number', 'Father Name', 'Passport No.', 'Passport Expiry Date', 'Joining Date', 'Created Date', 'Creator Name']
  },
  "cost-code-library": {
    title: "Cost Code Library",
    hasDownload: false,
    filters: [{ label: "Cost Code", type: "select", options: ["All"] }],
    columns: ['Cost Code', 'Sub Cost Code', 'Created Date', 'Description']
  },
  "material-library": {
    title: "Material Library",
    hasDownload: false,
    filters: [{ label: "Material Name", type: "select", options: ["All"] }, { label: "Material Category", type: "select", options: ["All"] }],
    columns: ['Item Code', 'Material Name', 'Specifications', 'Unit', 'Material Category', 'Created Date', 'Creator Name']
  },
  "rate-card-library": {
    title: "Rate Card Library",
    hasDownload: false,
    filters: [{ label: "(columns appear immediately, no distinct filter row identified)", type: "select", options: ["All"] }],
    columns: ['Description', 'Item Code', 'Cost Code', 'Unit', 'Components', 'Unit Cost Price', 'Markup Amount', 'Markup %', 'Selling Price', 'Created Date', 'Component Count', 'HSN/SAC']
  },
  "payroll-library": {
    title: "Payroll Library",
    hasDownload: false,
    filters: [{ label: "Name", type: "select", options: ["All"] }, { label: "Designation", type: "select", options: ["All"] }, { label: "Payroll Type", type: "select", options: ["All"] }],
    columns: ['Name', 'Designation', 'Payroll Type', 'CTC', 'Gross Salary', 'Net Salary', 'Shift Hours', 'Salary Breakup', 'Created Date']
  },
  "equipment-library": {
    title: "Equipment Library",
    hasDownload: false,
    filters: [{ label: "Equipment Name", type: "select", options: ["All"] }, { label: "Equipment No.", type: "select", options: ["All"] }, { label: "Created Date", type: "date" }],
    columns: ['Equipment Name', 'Make/Brand', 'Equipment No.', 'Model No.', 'Measurement Type', 'Unit', 'Created Date', 'Ownership Type', 'Expected Mileage', 'Purchase Amount', 'Insurance Policy No.', 'Insurance Provider Name', 'Insurance Start Date', 'Insurance Expiry Date', 'Service Reference No.', 'Last Service Date', 'Next Service Date', 'Fitness Certificate Ref No.', 'Fitness Certificate Status', 'Fitness Certificate Issue Date', 'Fitness Certificate Expiry Date', 'PUCC Reference No.', 'PUCC Start Date', 'PUCC Expiry Date', 'Permit Reference No.', 'Permit Start Date', 'Permit Expiry Date', 'Tax No.', 'Tax Start Date', 'Tax Expiry Date', 'Registration No.', 'Registration Start Date', 'Registration Expiry Date']
  },
  "boq-workorder-summary": {
    title: "BOQ Workorder Summary Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Client Name", type: "select", options: ["All"] }, { label: "Workorder Date", type: "date" }],
    columns: ['Project Name', 'Workorder Name', 'Workorder No.', 'Client Name', 'Estimated Amount', '% Order Complete', 'Work Done Amount', 'Billed Amount', 'Pending Billed', 'Workorder Date', 'Creator Name', 'Created Date']
  },
  "boq-item": {
    title: "BOQ Item Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Workorder Name", type: "select", options: ["All"] }, { label: "Workorder No.", type: "select", options: ["All"] }, { label: "Client Name", type: "select", options: ["All"] }, { label: "BOQ Date", type: "date" }],
    columns: ['Project Name', 'BOQ Name', 'BOQ No.', 'Client Name', 'BOQ Date', 'Group', 'Section', 'Item Name', 'Unit', 'Quantity', 'Progress Quantity', 'Billed Qty', 'Unbilled Qty', 'Unit Cost Price', 'Unit Sales Price', 'GST %', 'Amount w/o Tax', 'Total Amount', 'Cost Code']
  },
  "quotation": {
    title: "Quotation Report",
    hasDownload: false,
    filters: [{ label: "Quotation Number", type: "select", options: ["All"] }, { label: "Client Name", type: "select", options: ["All"] }, { label: "Quotation Date", type: "date" }],
    columns: ['Quotation Name', 'Quotation Number', 'Client Name', 'Quotation Date', 'Item Count', 'Item Sub Total', 'Discount', 'Additional Charges', 'Tax', 'Total Amount', 'Quotation Status', 'Created Date']
  },
  "quotation-item": {
    title: "Quotation Item Report",
    hasDownload: false,
    filters: [{ label: "Client Name", type: "select", options: ["All"] }, { label: "Quotation Name", type: "select", options: ["All"] }, { label: "Quotation Created", type: "select", options: ["All"] }],
    columns: ['Client Name', 'Quotation Name', 'Quotation Status', 'Quotation Date', 'Group', 'Section', 'Item Name', 'Unit', 'Estimated Qty', 'Unit Cost Price', 'Markup', 'Sales Unit Price', 'Total Sales Amount', 'Tax %', 'Total with Tax']
  },
  "boq-measurement-book": {
    title: "BOQ Measurement Book",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Workorder Name", type: "select", options: ["All"] }, { label: "Workorder No.", type: "select", options: ["All"] }, { label: "Client Name", type: "select", options: ["All"] }, { label: "Progress Date", type: "date" }],
    columns: ['Project Name', 'Workorder No.', 'Group', 'Section', 'Item Name', 'Progress Date', 'Unit', 'Estimated Quantity', 'Opening Quantity', 'Number', 'Length', 'Width', 'Height', 'Progress Quantity', 'Closing Quantity', 'Progress Notes']
  },
  "boq-bom": {
    title: "BOQ BOM Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "BOQ Name", type: "select", options: ["All"] }, { label: "Material Name", type: "select", options: ["All"] }],
    columns: ['Project Name', 'BOQ Name', 'Item Name', 'Material Name', 'Unit', 'Unit Price', 'Quantity', 'Total Cost Price', 'Creation Date']
  },
  "budget-vs-actual-material-cost": {
    title: "Budget vs Actual (Material Cost)",
    hasDownload: false,
    filters: [{ label: "Project", type: "select", options: ["All"] }, { label: "Material", type: "select", options: ["All"] }],
    columns: ['Project', 'Material', 'Unit', 'Budget Cost (INR)', 'Actual Cost (INR)', 'Variance (INR)']
  },
  "budget-vs-actual-material-qty": {
    title: "Budget vs Actual (Material Qty)",
    hasDownload: false,
    filters: [{ label: "Project", type: "select", options: ["All"] }, { label: "Material", type: "select", options: ["All"] }],
    columns: ['Project', 'Material', 'Unit', 'Budget Qty', 'Actual Qty', 'Variance Qty']
  },
  "budget-vs-actual-cost-code": {
    title: "Budget vs Actual (Cost Code)",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Cost Code", type: "select", options: ["All"] }, { label: "Sub Cost Code", type: "select", options: ["All"] }],
    columns: ['Cost Code', 'Budget Amount (INR)', 'Actual Amount (INR)', 'Variance (INR)', 'Status']
  },
  "asset-allocation": {
    title: "Asset Allocation Report",
    hasDownload: false,
    filters: [{ label: "Project Name", type: "select", options: ["All"] }, { label: "Asset Name", type: "select", options: ["All"] }, { label: "Asset Type", type: "select", options: ["All"] }, { label: "Assigned To", type: "select", options: ["All"] }, { label: "Assigned Time", type: "select", options: ["All"] }, { label: "Creation Date", type: "date" }],
    columns: ['Asset Code', 'Asset Name', 'Asset Type', 'Assigned To', 'Allocation Type', 'Created by', 'Project Name', 'Assigned Time', 'Assigned Qty', 'Remaining Qty']
  },
  "asset-status": {
    title: "Asset Status Report",
    hasDownload: false,
    filters: [{ label: "Asset Code", type: "select", options: ["All"] }, { label: "Asset Name", type: "select", options: ["All"] }, { label: "Asset Type", type: "select", options: ["All"] }],
    columns: ['Asset Code', 'Asset Name', 'Asset Type', 'Total Qty', 'Available Qty', 'Assigned Qty', 'In Repair Qty', 'Damaged Qty', 'Asset Value', 'Created by', 'Creation Date', 'Last Assigned To', 'Last Assigned Time']
  }
};

// The API sends raw ISO timestamps and bare numbers; the export path already
// formats them, the on-screen table printed them as-is.
const NON_GROUPED_COL = /year|number|\bno\.?$|code|\bpin\b|phone|mobile|gstin|\bpan\b|\bhsn\b|\bsac\b|%|percent/i;
function formatReportCell(col: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return formatDateTime(value, value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value, value);
    return value;
  }
  if (typeof value === "number" && !NON_GROUPED_COL.test(col)) {
    return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  return String(value);
}

export default function DynamicReportViewPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const slug = params?.slug as string;

  useEffect(() => {
    if (isMissingOrDemoTenant(companyId)) {
      redirectToLogin();
    }
  }, [companyId]);

  const [toastMessage, setToastMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc" | null>(null);

  // Load report meta configuration
  const meta = REPORT_METADATA[slug];

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3000);
  };

  // Set up filters state dynamically based on meta filter configuration
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (meta) {
      meta.filters.forEach(f => {
        initial[f.label] = f.type === "select" ? "All" : "";
      });
    }
    return initial;
  });

  if (!meta) {
    return (
      <div className="flex h-screen bg-background text-foreground items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-danger font-bold">Report configuration not found for slug "{slug}"</p>
          <Link href={`/c/${companyId}/reports`} className="text-xs text-primary underline">Back to Reports Hub</Link>
        </div>
      </div>
    );
  }

  const handleFilterChange = (label: string, val: string) => {
    setFilterValues(prev => ({ ...prev, [label]: val }));
  };

  const handleRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
    showToast("Refreshed data.");
  };

  const handleResetFilters = () => {
    const reset: Record<string, string> = {};
    meta.filters.forEach(f => {
      reset[f.label] = f.type === "select" ? "All" : "";
    });
    setFilterValues(reset);
    setSearchQuery("");
    showToast("Filters reset to default.");
  };

  const handleSort = () => {
    const nextDir = sortDirection === "asc" ? "desc" : "asc";
    setSortDirection(nextDir);
    showToast(`Sorted table rows in ${nextDir.toUpperCase()} order.`);
  };

  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [crmLeads, setCrmLeads] = useState<any[]>([]);
  const [financePayments, setFinancePayments] = useState<any[]>([]);

  useEffect(() => {
    if (isMissingOrDemoTenant(companyId)) return;
    const fetchReport = async () => {
      setLoading(true);
      setReportError(null);
      try {
        const res = await fetch(`${getApiHost()}/apis/v3/reports/data/${slug}?company_id=${companyId}`, {
          headers: { ...(authHeaders() || {}) }
        });
        if (!res.ok) {
          setReportError(`Failed to load report data (HTTP ${res.status}).`);
          setRows([]);
        } else {
          const data = await res.json();
          if (data.errors && data.errors.length > 0) {
            setReportError(data.errors[0]);
            setRows([]);
          } else {
            setReportError(null);
            setRows(data.rows || []);
          }
        }
      } catch (err: any) {
        setReportError(err?.message || "Failed to load report data.");
        setRows([]);
      } finally {
        setLoading(false);
      }
    };
    fetchReport();

    if (slug === "lead-status-funnel") {
      fetch(`${getApiHost()}/apis/v3/crm/leads?company_id=${companyId}`, {
        headers: { ...(authHeaders() || {}) }
      })
      .then(res => res.ok ? res.json() : [])
      .then(data => setCrmLeads(Array.isArray(data) ? data : []))
      .catch(() => setCrmLeads([]));
    }

    if (slug === "cost-code-expense-analysis") {
      // R2-394: /finance/payments exposes POST only, so this GET always answered
      // 405 and res.ok ? :[] rendered it as "no expenses recorded"; read the
      // company ledger from GET /finance/transactions/{company_id} instead and
      // keep the expense-side bill rows finance.py books under total_expense.
      fetch(`${getApiHost()}/apis/v3/finance/transactions/${companyId}`, {
        headers: { ...(authHeaders() || {}) }
      })
      .then(res => res.ok ? res.json() : null)
      .then((data: any) => {
        const txns: any[] = Array.isArray(data?.transactions) ? data.transactions : [];
        const expenseTypes = ["Material Purchase", "Subcon Bill", "Other Expense", "Equipment Expense"];
        setFinancePayments(txns.filter(t => expenseTypes.includes(t.type)));
      })
      .catch(() => setFinancePayments([]));
    }
  }, [slug, companyId, refreshTrigger]);

  // The select filters were declared with only "All", so picking a project
  // (or party, material...) was impossible. Offer the values the report holds.
  const filterColumn = (label: string) => meta.columns.find(c => c.toLowerCase().includes(label.toLowerCase()));
  const selectOptions = (label: string): string[] => {
    const col = filterColumn(label);
    if (!col) return ["All"];
    const values = new Set<string>();
    rows.forEach(row => {
      const v = row[col];
      if (v !== null && v !== undefined && String(v).trim() !== "") values.add(String(v));
    });
    return ["All", ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  };

  // Filter rows based on search and filters
  const filteredData = rows.filter(row => {
    // 1. Match search query across all cells
    if (searchQuery !== "") {
      const rowString = JSON.stringify(row).toLowerCase();
      if (!rowString.includes(searchQuery.toLowerCase())) {
        return false;
      }
    }
    // 2. Match active select dropdown filters
    for (const filterLabel in filterValues) {
      const val = filterValues[filterLabel];
      if (val !== "All" && val !== "") {
        // Find if a column name matches the filter label
        const matchedCol = filterColumn(filterLabel);
        if (!matchedCol) continue;
        const cell = String(row[matchedCol] ?? "");
        const isSelect = meta.filters.some(f => f.label === filterLabel && f.type === "select");
        if (isSelect ? cell !== val : !cell.toLowerCase().includes(val.toLowerCase())) {
          return false;
        }
      }
    }
    return true;
  });

  // Apply sorting
  const processedData = React.useMemo(() => {
    if (!sortDirection || meta.columns.length === 0) return filteredData;
    const sorted = [...filteredData];
    const sortCol = meta.columns[0];
    sorted.sort((a, b) => {
      const valA = (a[sortCol] || "").toLowerCase();
      const valB = (b[sortCol] || "").toLowerCase();
      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredData, sortDirection, meta.columns]);

  // Handle format export selection
  const handleExportSelect = (format: string) => {
    setShowExportDropdown(false);
    
    const exportColumns = meta.columns.filter(col => processedData.length === 0 || processedData.some(row => (row[col] ?? "") !== ""));
    const formatExportCell = (value: unknown) => {
      if (value === null || value === undefined) return "";
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toLocaleString("en-IN");
      }
      return value;
    };
    const headers = ["#", ...exportColumns];
    // R2-755: lifted into lib/csv.ts so every CSV builder can share it. The
    // guard was correct here and simply did not reach the other four exports.
    const dataRows = processedData.map((row, i) => [
      String(i + 1),
      ...exportColumns.map(col => formatExportCell(row[col]))
    ]);

    if (format === "html") {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>${meta.title}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 24px; background: #0b0f19; color: #f3f4f6; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; background: #111827; border: 1px solid #374151; border-radius: 8px; overflow: hidden; }
            th, td { border-bottom: 1px solid #374151; padding: 12px 16px; text-align: left; font-size: 13px; }
            th { background-color: #312e81; color: #ffffff; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
            tr:hover { background-color: #1f2937; }
            h2 { color: #ffffff; margin-bottom: 4px; }
            p { color: #9ca3af; font-size: 12px; margin-top: 0; }
          </style>
        </head>
        <body>
          <h2>${meta.title}</h2>
          <p>Generated on: ${formatDateTime(new Date())}</p>
          <table>
            <thead>
              <tr>
                ${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${dataRows.map(row => `
                <tr>
                  ${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </body>
        </html>
      `;
      const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${meta.title.toLowerCase().replace(/[^a-z0-9]/g, "_")}_export.html`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast("Report exported successfully as HTML!");
      return;
    }

    if (format === "pdf") {
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        showToast("Export failed: the browser blocked the print popup. Allow popups for this site and try again.");
        return;
      }
      printWindow.document.write(`
          <html>
          <head>
            <title>${meta.title}</title>
            <style>
              body { font-family: sans-serif; padding: 20px; color: #333; }
              table { width: 100%; border-collapse: collapse; margin-top: 20px; }
              th, td { border: 1px solid #ccc; padding: 10px; text-align: left; font-size: 12px; }
              th { background-color: #f3f4f6; font-weight: bold; }
              h2 { margin-bottom: 5px; }
              p { margin-top: 0; color: #666; font-size: 11px; }
            </style>
          </head>
          <body>
            <h2>${meta.title}</h2>
            <p>Generated on: ${new Date().toLocaleString("en-IN")}</p>
            <table>
              <thead>
                <tr>
                  ${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${dataRows.map(row => `
                  <tr>
                    ${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}
                  </tr>
                `).join("")}
              </tbody>
            </table>
            <script>
              window.onload = function() {
                window.print();
                window.close();
              }
            </script>
          </body>
          </html>
        `);
      printWindow.document.close();
      showToast("Exported PDF print preview generated!");
      return;
    }

    // Default to CSV / Excel (CSV formatted stream)
    const csvContent = [
      headers.join(","),
      ...dataRows.map(r => r.map(c => csvQuote(csvSafeCell(c))).join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    
    const extension = "csv";
    const cleanFileName = meta.title.toLowerCase().replace(/[^a-z0-9]/g, "_") + `_export.${extension}`;
    link.setAttribute("download", cleanFileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast("Report exported successfully as CSV!");
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={meta?.title || slug}
        subtitle="Spreadsheet view, dynamic column aggregations, and export engine"
      >
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} className="text-foreground text-xs border border-border-custom bg-card/50 hover:bg-elevated rounded-lg px-3 py-1.5 transition-all inline-flex items-center gap-1.5 cursor-pointer"><Icon name="refresh" className="w-3.5 h-3.5" /> Refresh</button>
          {/* Dynamic 4-option export dropdown button */}
          <div className="relative">
            <button 
              onClick={() => setShowExportDropdown(!showExportDropdown)}
              className="text-white text-xs bg-primary hover:bg-primary/90 font-bold rounded-lg px-3.5 py-1.5 transition-all flex items-center gap-1 cursor-pointer"
              title="Export Options"
            >
              <Icon name="arrow_up" className="w-3.5 h-3.5" /> Export
            </button>
            {showExportDropdown && (
              <div className="absolute right-0 mt-2 w-40 bg-card border border-border-custom rounded-lg shadow-xl py-1 z-50">
                <button onClick={() => handleExportSelect("csv")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors cursor-pointer">Export as CSV</button>
                <button onClick={() => handleExportSelect("pdf")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors cursor-pointer">Export as PDF</button>
                <button onClick={() => handleExportSelect("html")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors cursor-pointer">Export as HTML</button>
              </div>
            )}
          </div>
        </div>
      </PageHeader>

        {/* Filters + Action Header bar */}
        <div className="bg-sidebar border-b border-border-custom px-6 py-4 flex flex-col gap-4 shrink-0">
          
          {/* Top Row: Info/Heading + Right Toolbar Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="text-[10px] text-muted font-bold uppercase tracking-wider">
              Spreadsheet View & Controls
            </div>

            {/* Actions Toolbar & Search Bar */}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={handleRefresh} className="text-muted hover:text-foreground text-xs border border-border-custom bg-card/20 rounded-lg px-3 py-1.5 transition-all inline-flex items-center gap-1.5"><Icon name="refresh" className="w-3.5 h-3.5" /> Refresh</button>
              <button onClick={handleResetFilters} className="text-muted hover:text-foreground text-xs border border-border-custom bg-card/20 rounded-lg px-3 py-1.5 transition-all">Filter</button>
              <button onClick={handleSort} className="text-muted hover:text-foreground text-xs border border-border-custom bg-card/20 rounded-lg px-3 py-1.5 transition-all">Sort</button>
              
              {/* Dynamic 4-option export dropdown button */}
              <div className="relative">
                <button 
                  onClick={() => setShowExportDropdown(!showExportDropdown)}
                  className="text-muted hover:text-primary text-xs border border-border-custom bg-card/20 rounded-lg px-3 py-1.5 transition-all flex items-center gap-1"
                  title="Export Options"
                >
                  <Icon name="arrow_up" className="w-3.5 h-3.5" /> Export
                </button>
                {showExportDropdown && (
                  <div className="absolute right-0 mt-2 w-40 bg-card border border-border-custom rounded-lg shadow-xl py-1 z-50">
                    <button onClick={() => handleExportSelect("csv")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors">Export as CSV</button>
                    <button onClick={() => handleExportSelect("pdf")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors">Export as PDF</button>
                    <button onClick={() => handleExportSelect("html")} className="w-full text-left px-4 py-2 text-xs text-muted hover:bg-elevated hover:text-white transition-colors">Export as HTML</button>
                  </div>
                )}
              </div>

              <div className="relative">
                <input
                  type="text"
                  placeholder="Search Data..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="bg-card border border-border-custom rounded-lg pl-7 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-primary w-40 transition-all focus:w-48"
                />
                <Icon name="search" className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted" />
              </div>
            </div>
          </div>

          {/* Bottom Row: Dynamic Filters Area */}
          {meta.filters.length > 0 && (
            <div className="border-t border-border-custom/50 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-muted font-black uppercase tracking-wider">Report Filters</span>
                {(Object.entries(filterValues).some(([label, val]) => {
                  const def = meta.filters.find(f => f.label === label)?.type === "select" ? "All" : "";
                  return val !== def;
                }) || searchQuery !== "") && (
                  <button 
                    onClick={handleResetFilters}
                    className="text-[9px] text-primary hover:underline font-bold"
                  >
                    Clear All Filters
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-3 text-xs">
                {meta.filters.map(filter => (
                  <div key={filter.label} className="flex flex-col gap-1">
                    <span className="text-[10px] text-muted uppercase font-bold">{filter.label}:</span>
                    {filter.type === "select" ? (
                      <select
                        value={filterValues[filter.label] || "All"}
                        onChange={e => handleFilterChange(filter.label, e.target.value)}
                        className="bg-card border border-border-custom rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-primary min-w-[130px]"
                      >
                        {selectOptions(filter.label).map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="date"
                        value={filterValues[filter.label] || ""}
                        onChange={e => handleFilterChange(filter.label, e.target.value)}
                        className="bg-card border border-border-custom rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-primary"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Dynamic Data Table or Visual Dashboard Charts */}
        <div className="flex-1 overflow-auto">
          <PageShell width="wide">
          {reportError && (
            <div className="mb-4 p-4 rounded-xl bg-danger/10 border border-danger/20 text-danger text-xs flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold">Report Error:</span>
                <span>{reportError}</span>
              </div>
              <button
                onClick={() => setRefreshTrigger(prev => prev + 1)}
                className="px-3 py-1 bg-danger/20 hover:bg-danger/30 rounded text-xs font-semibold transition-colors cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}
          {slug === "lead-status-funnel" ? (() => {
            const totalLeadsCount = crmLeads.length;
            // R2-437: these arrays matched none of the seven statuses the CRM
            // actually ships (backend crm.py DEFAULT_STATUSES: New Lead,
            // Follow-Up, Proposal Stage, Converted, Won, Lost, No Response,
            // Irrelevant Lead), so every stage below the baseline read 0% for
            // ever. Each stage now accepts the shipped names alongside the
            // legacy ones, cumulative down the funnel, dead ends excluded.
            const contactedLeads = crmLeads.filter(l => ["Contacted", "Follow-Up", "Qualified", "Site Visit", "Proposal Sent", "Proposal Stage", "Negotiation", "Converted", "Won"].includes(l.status)).length;
            const siteVisitLeads = crmLeads.filter(l => ["Qualified", "Site Visit", "Proposal Sent", "Proposal Stage", "Negotiation", "Converted", "Won"].includes(l.status)).length;
            const quotationLeads = crmLeads.filter(l => ["Proposal Sent", "Proposal Stage", "Negotiation", "Converted", "Won"].includes(l.status)).length;
            const wonLeads = crmLeads.filter(l => ["Won", "Converted"].includes(l.status)).length;

            const contactedPct = totalLeadsCount > 0 ? Math.round((contactedLeads / totalLeadsCount) * 100) : 0;
            const siteVisitPct = totalLeadsCount > 0 ? Math.round((siteVisitLeads / totalLeadsCount) * 100) : 0;
            const quotationPct = totalLeadsCount > 0 ? Math.round((quotationLeads / totalLeadsCount) * 100) : 0;
            const wonPct = totalLeadsCount > 0 ? Math.round((wonLeads / totalLeadsCount) * 100) : 0;

            return (
              <div className="max-w-4xl mx-auto bg-card border border-border-custom rounded-xl p-8 space-y-8">
                <div className="border-b border-border-custom pb-4">
                  <h3 className="text-base font-bold text-white uppercase tracking-wider inline-flex items-center gap-2"><Icon name="bar_chart" className="w-5 h-5" /> Lead Status Funnel Analysis</h3>
                  <p className="text-xs text-muted mt-1">Real-time conversion metrics calculated from active CRM pipeline leads.</p>
                </div>

                <div className="space-y-5">
                  {/* Segment 1 */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-primary">1. New Enquiries</span>
                      <span className="text-white">{totalLeadsCount} Leads (100% baseline)</span>
                    </div>
                    <div className="h-9 w-full bg-primary rounded-lg flex items-center px-4 hover:opacity-95 transition-opacity min-w-[75px]">
                      <span className="text-[11px] font-bold text-white font-sans tracking-wide whitespace-nowrap">{totalLeadsCount} / {totalLeadsCount}</span>
                    </div>
                  </div>

                  {/* Segment 2 */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-info">2. Contacted / Qualified</span>
                      <span className="text-white">{contactedLeads} Leads ({contactedPct}% conversion)</span>
                    </div>
                    <div className="h-9 bg-info rounded-lg flex items-center px-4 hover:opacity-95 transition-opacity min-w-[75px]" style={{ width: `${Math.max(contactedPct, 8)}%` }}>
                      <span className="text-[11px] font-bold text-white font-sans tracking-wide whitespace-nowrap">{contactedLeads} / {totalLeadsCount}</span>
                    </div>
                  </div>

                  {/* Segment 3 */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-chart-3">3. Site Visit Scheduled</span>
                      <span className="text-white">{siteVisitLeads} Leads ({siteVisitPct}% conversion)</span>
                    </div>
                    <div className="h-9 bg-chart-3 rounded-lg flex items-center px-4 hover:opacity-95 transition-opacity min-w-[75px]" style={{ width: `${Math.max(siteVisitPct, 8)}%` }}>
                      <span className="text-[11px] font-bold text-white font-sans tracking-wide whitespace-nowrap">{siteVisitLeads} / {totalLeadsCount}</span>
                    </div>
                  </div>

                  {/* Segment 4 */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-chart-4">4. Quotation Shared</span>
                      <span className="text-white">{quotationLeads} Leads ({quotationPct}% conversion)</span>
                    </div>
                    <div className="h-9 bg-chart-4 rounded-lg flex items-center px-4 hover:opacity-95 transition-opacity min-w-[75px]" style={{ width: `${Math.max(quotationPct, 8)}%` }}>
                      <span className="text-[11px] font-bold text-white font-sans tracking-wide whitespace-nowrap">{quotationLeads} / {totalLeadsCount}</span>
                    </div>
                  </div>

                  {/* Segment 5 */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-success">5. Client Confirmed / Won</span>
                      <span className="text-white">{wonLeads} Leads ({wonPct}% conversion)</span>
                    </div>
                    <div className="h-9 bg-success rounded-lg flex items-center px-4 hover:opacity-95 transition-opacity min-w-[75px]" style={{ width: `${Math.max(wonPct, 8)}%` }}>
                      <span className="text-[11px] font-bold text-white font-sans tracking-wide whitespace-nowrap">{wonLeads} / {totalLeadsCount}</span>
                    </div>
                  </div>
                </div>

                {/* Conversion Summary Stats */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4 border-t border-border-custom text-center">
                  <div className="p-3 bg-white/[0.01] border border-border-custom rounded-lg">
                    <div className="text-[10px] text-muted uppercase font-bold">Total Enquiries</div>
                    <div className="text-lg font-black text-white mt-1">{totalLeadsCount}</div>
                  </div>
                  <div className="p-3 bg-white/[0.01] border border-border-custom rounded-lg">
                    <div className="text-[10px] text-muted uppercase font-bold">Proposal Rate</div>
                    <div className="text-lg font-black text-white mt-1">{quotationPct}%</div>
                  </div>
                  <div className="p-3 bg-white/[0.01] border border-border-custom rounded-lg">
                    <div className="text-[10px] text-muted uppercase font-bold">Win Rate</div>
                    <div className="text-lg font-black text-white mt-1">{wonPct}%</div>
                  </div>
                </div>
              </div>
            );
          })() : slug === "cost-code-expense" ? (() => {
            /* HIGH-AESTHETIC CATEGORICAL DONUT GRAPHIC FOR COST CODE EXPENSE */
            const totalSpent = processedData.reduce((acc, row) => acc + (Number(row.amount) || 0), 0);
            const groups: Record<string, number> = {};
            processedData.forEach(row => {
              const name = String(row.cost_code || row.name || "General");
              groups[name] = (groups[name] || 0) + (Number(row.amount) || 0);
            });
            const entries = Object.entries(groups).sort((a, b) => b[1] - a[1]);
            const colors = ["bg-primary", "bg-info", "bg-chart-3", "bg-chart-4", "bg-success"];
            const textColors = ["text-primary", "text-info", "text-chart-3", "text-chart-4", "text-success"];

            return (
              <div className="max-w-4xl mx-auto bg-card border border-border-custom rounded-xl p-8 space-y-8">
                <div className="border-b border-border-custom pb-4">
                  <h3 className="text-base font-bold text-white uppercase tracking-wider inline-flex items-center gap-2"><Icon name="bar_chart" className="w-5 h-5" /> Cost Code Expense Breakdown</h3>
                  <p className="text-xs text-muted mt-1">Detailed analysis of company expenditures calculated from recorded expense bills.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                  {/* Donut graphic */}
                  <div className="flex justify-center relative py-6">
                    <div className="w-48 h-48 rounded-full border-8 border-primary flex items-center justify-center relative">
                      <div className="w-32 h-32 rounded-full bg-card flex flex-col items-center justify-center text-center border border-border-custom">
                        <span className="text-[10px] text-muted uppercase font-bold">Total Spent</span>
                        <span className="text-base font-extrabold text-white mt-1">₹{totalSpent.toLocaleString("en-IN")}</span>
                      </div>
                    </div>
                  </div>

                  {/* Legend list */}
                  <div className="space-y-4">
                    {entries.length === 0 ? (
                      <EmptyState
                        title="No expense transactions recorded yet"
                        description="Cost code expenses will populate here as material receipts and contractor payments are recorded."
                      />
                    ) : (
                      entries.map(([ccName, ccAmt], idx) => {
                        const pct = totalSpent > 0 ? ((ccAmt / totalSpent) * 100).toFixed(1) : "0.0";
                        const dotColor = colors[idx % colors.length];
                        const txtColor = textColors[idx % textColors.length];
                        return (
                          <div key={ccName} className="p-3 bg-white/[0.01] border border-border-custom rounded-lg flex items-center justify-between hover:bg-elevated transition-colors">
                            <div className="flex items-center gap-3">
                              <span className={`h-3 w-3 rounded-full ${dotColor} shrink-0`} />
                              <div className="flex flex-col">
                                <span className="text-xs font-bold text-white">{ccName}</span>
                                <span className="text-[10px] text-muted">Cost Code Ledger</span>
                              </div>
                            </div>
                            <div className="text-right">
                              <span className="text-xs font-extrabold text-white block">₹{ccAmt.toLocaleString("en-IN")}</span>
                              <span className={`text-[10px] ${txtColor} font-bold`}>{pct}%</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            );
          })() : slug === "monthly-pl" ? (() => {
            const rows = processedData;
            const totalRev = rows.reduce((acc, r) => acc + (Number(r["Revenue (INR)"]) || 0), 0);
            const totalExp = rows.reduce((acc, r) => acc + (Number(r["Expense (INR)"]) || 0), 0);
            const netPL = totalRev - totalExp;
            const margin = totalRev > 0 ? ((netPL / totalRev) * 100).toFixed(1) : "0.0";

            return (
              <div className="max-w-4xl mx-auto space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 bg-card border border-border-custom rounded-xl">
                    <div className="text-[10px] text-muted uppercase font-bold">Total Revenue</div>
                    <div className="text-xl font-bold text-success mt-1">₹{totalRev.toLocaleString("en-IN")}</div>
                  </div>
                  <div className="p-4 bg-card border border-border-custom rounded-xl">
                    <div className="text-[10px] text-muted uppercase font-bold">Total Expense</div>
                    <div className="text-xl font-bold text-danger mt-1">₹{totalExp.toLocaleString("en-IN")}</div>
                  </div>
                  <div className="p-4 bg-card border border-border-custom rounded-xl">
                    <div className="text-[10px] text-muted uppercase font-bold">Net Profit / Loss</div>
                    <div className={`text-xl font-bold mt-1 ${netPL >= 0 ? "text-primary" : "text-danger"}`}>
                      ₹{netPL.toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="p-4 bg-card border border-border-custom rounded-xl">
                    <div className="text-[10px] text-muted uppercase font-bold">Profit Margin</div>
                    <div className="text-xl font-bold text-foreground mt-1">{margin}%</div>
                  </div>
                </div>

                {/* Monthly Breakdown Table */}
                <div className="rounded-xl border border-border-custom bg-card overflow-hidden">
                  <div className="px-5 py-3 border-b border-border-custom bg-elevated/40">
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Monthly P&L Ledger</h3>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-elevated text-muted border-b border-border-custom">
                        <th className="px-4 py-2.5 text-left font-semibold">Month</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Revenue (INR)</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Expense (INR)</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Net P&L (INR)</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Margin (%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-8">
                            <EmptyState
                              title="No monthly transactions recorded yet"
                              description="Monthly revenue and expense summaries will appear as bills and invoices are processed."
                            />
                          </td>
                        </tr>
                      ) : (
                        rows.map((r, i) => (
                          <tr key={i} className="border-t border-border-custom hover:bg-elevated/40 transition-colors">
                            <td className="px-4 py-2.5 text-foreground font-semibold">{r["Month"]}</td>
                            <td className="px-4 py-2.5 text-right text-success font-medium">₹{Number(r["Revenue (INR)"] || 0).toLocaleString("en-IN")}</td>
                            <td className="px-4 py-2.5 text-right text-danger font-medium">₹{Number(r["Expense (INR)"] || 0).toLocaleString("en-IN")}</td>
                            <td className={`px-4 py-2.5 text-right font-bold ${Number(r["Net P&L (INR)"] || 0) >= 0 ? "text-primary" : "text-danger"}`}>
                              ₹{Number(r["Net P&L (INR)"] || 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-4 py-2.5 text-right text-muted">{r["Profit Margin (%)"]}%</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })() : (
            /* STANDARD DATA TABLE */
            loading ? (
              <TableSkeleton rows={8} cols={meta.columns.length || 6} />
            ) : (
              <div className="min-w-full overflow-x-auto rounded-xl border border-border-custom bg-card">
                <table className="w-full text-xs">
                <thead>
                  <tr className="bg-primary text-white">
                    <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap w-12">#</th>
                    {meta.columns.map(col => (
                      <th key={col} className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {processedData.length === 0 ? (
                    <tr>
                      <td colSpan={meta.columns.length + 1} className="p-8">
                        <EmptyState
                          title="No data available for this report yet"
                          description="Try clearing active filters or verify that underlying project transactions exist."
                        />
                      </td>
                    </tr>
                  ) : (
                    processedData.map((row, i) => (
                      <tr key={i} className="border-t border-border-custom hover:bg-elevated/40 transition-colors">
                        <td className="px-3 py-2.5 text-muted">{i + 1}</td>
                        {meta.columns.map(col => (
                          <td key={col} className="px-3 py-2.5 text-foreground whitespace-nowrap">
                            {formatReportCell(col, row[col])}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            )
          )}
          </PageShell>
        </div>

        {/* Back Navigation Bar */}
        <div className="px-6 py-3 border-t border-border-custom bg-sidebar shrink-0">
          <Link href={`/c/${companyId}/reports`} className="text-xs text-muted hover:text-primary transition-colors flex items-center gap-1.5 w-fit">
            <Icon name="arrow_left" className="w-3.5 h-3.5" /> Back to Reports Hub
          </Link>
        </div>

        {/* Toast */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 bg-card border border-success/30 rounded-lg px-4 py-3 text-xs text-success shadow-lg flex items-center gap-2 z-50">
            <Icon name="bolt" className="w-4 h-4" />
            <span className="font-semibold">{toastMessage}</span>
          </div>
        )}
    </div>
  );
}

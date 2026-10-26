"use client";

import React from "react";
import Link from "next/link";
import { type IconName } from "@/components/marketing/Icon";
import { startHereCategory } from "./startHere";

export interface FaqItem {
  q: string;
  a: React.ReactNode;
  text: string;
  sources: string[];
}

export interface HelpCategory {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  items: FaqItem[];
}

export type FaqCategory = HelpCategory;

export interface ModuleLink {
  label: string;
  href: string;
}

export const HELP_MODULE_LINKS = (companyId: string): ModuleLink[] => {
  const p = (path: string) => `/c/${companyId}${path.startsWith("/") ? path : `/${path}`}`;
  return [
    { label: "Dashboard", href: p("/dashboard") },
    { label: "Projects", href: p("/projects") },
    { label: "Planning", href: p("/d/planning") },
    { label: "Drawings", href: p("/d/drawings") },
    { label: "DPR", href: p("/d/dpr") },
    { label: "Quality & NCR", href: p("/d/quality") },
    { label: "Safety", href: p("/d/safety") },
    { label: "Labour", href: p("/d/labour") },
    { label: "Attendance", href: p("/d/attendance") },
    { label: "Equipment", href: p("/d/equipment") },
    { label: "Production", href: p("/d/production") },
    { label: "Procurement", href: p("/d/procurement") },
    { label: "Three-Way Match", href: p("/d/three-way") },
    { label: "Materials & Stock", href: p("/materials") },
    { label: "Subcontractors", href: p("/d/subcon") },
    { label: "Cost Codes", href: p("/cost-codes") },
    { label: "Finance", href: p("/d/finance") },
    { label: "Billing", href: p("/d/billing") },
    { label: "Payroll", href: p("/d/payroll-attendance") },
    { label: "HR & Staff", href: p("/d/hr") },
    { label: "Budget", href: p("/d/budget") },
    { label: "CRM & Leads", href: p("/d/crm") },
    { label: "Library", href: p("/d/library") },
    { label: "Analytics", href: p("/analytics") },
    { label: "Reports", href: p("/reports") },
    { label: "Settings", href: p("/settings") },
  ];
};

function c(companyId: string, path: string): string {
  return `/c/${companyId}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getHelpCategories(companyId: string): HelpCategory[] {
  return [
    startHereCategory(companyId),
    {
      id: "getting-started",
      title: "Getting Started",
      description: "Company setup, first project, user access, and role permissions.",
      icon: "rocket",
      items: [
        {
          q: "How do I create a company?",
          a: (
            <>
              <p>
                Sign up with a verified phone number or email address to get started.
              </p>
              <p className="mt-2">
                When you sign in without an active company, you will be directed to the onboarding screen at{" "}
                <Link className="help-link" href="/onboarding">
                  /onboarding
                </Link>
                .
              </p>
              <p className="mt-2">
                Enter your company name, phone, city, and segment (such as builder, contractor, or project management), with optional legal entity details, GSTIN, billing address, and logo.
              </p>
              <p className="mt-2">
                Saving creates your company workspace and assigns your account as the owner.
              </p>
              <p className="mt-2">
                From there you can create your first construction project from the projects directory.
              </p>
            </>
          ),
          text: "create company onboarding owner sign up gstin legal name phone city segment builder contractor setup workspace",
          sources: [
            "frontend/src/app/onboarding/page.tsx:1",
            "POST /apis/v3/auth/onboarding/create-company",
          ],
        },
        {
          q: "How do I create a project?",
          a: (
            <>
              <p>
                You will need permission to manage projects or hold the owner role in your company.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/projects")}>
                  "Projects"
                </Link>
                , and click the "+ Create Project" button in the header.
              </p>
              <p className="mt-2">
                Enter the project name, project code, state for GST place of supply, and map coordinates, along with optional client details, address, dates, and estimated value.
              </p>
              <p className="mt-2">
                Saving creates the new project workspace immediately.
              </p>
              <p className="mt-2">
                Switch your active project in the top navigation bar to begin scheduling tasks and uploading drawings.
              </p>
            </>
          ),
          text: "create project new code location lat long state place of supply site start date",
          sources: [
            "frontend/src/components/Sidebar.tsx:105",
            "frontend/src/app/c/[company_id]/projects/page.tsx:1",
            "POST /apis/v3/projects/",
          ],
        },
        {
          q: "How do I add team members?",
          a: (
            <>
              <p>
                You will need permission to manage team members or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Team" tab.
              </p>
              <p className="mt-2">
                Provide the member's full name, mobile number or email address, and their assigned role, with optional designation and project assignments.
              </p>
              <p className="mt-2">
                Saving sends an invitation link and adds the member to your workspace roster.
              </p>
              <p className="mt-2">
                The invited member can sign in immediately to access assigned projects under their permissions.
              </p>
            </>
          ),
          text: "add team members invite user staff assign role permissions mobile email company team",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "POST /apis/v3/auth/team/invite",
          ],
        },
        {
          q: "How do roles and permissions work?",
          a: (
            <>
              <p>
                You will need permission to manage settings or hold the owner role to configure custom roles.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Roles & Access" tab.
              </p>
              <p className="mt-2">
                Enter a role name, description, and select the specific module permissions you want to grant or restrict.
              </p>
              <p className="mt-2">
                Saving updates the permission policy and applies access controls across all features immediately.
              </p>
              <p className="mt-2">
                Assign your configured roles to teammates from the "Team" tab.
              </p>
            </>
          ),
          text: "roles permissions rbac access control manage settings fail closed grant revoke custom roles",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "POST /apis/v3/settings/roles/{company_id}",
          ],
        },
      ],
    },
    {
      id: "planning-dpr",
      title: "Project Planning & DPR",
      description: "BOQ imports, task scheduling, Gantt milestones, and daily progress logs.",
      icon: "calendar",
      items: [
        {
          q: "How do I import a BOQ?",
          a: (
            <>
              <p>
                You will need a project open and permission to edit budgets.
              </p>
              <p className="mt-2">
                Open the project from{" "}
                <Link className="help-link" href={c(companyId, "/projects")}>
                  "Projects"
                </Link>
                , go to its BOQ tab and press "+ BOQ". Give the BOQ a title and choose the client.
              </p>
              <p className="mt-2">
                Open the BOQ you created and use "Import Excel items into this BOQ" to upload a .xlsx or .xlsm sheet with columns for item description, quantity, unit and rate (or supply and installation rates), with optional section names and cost codes. You can also type lines one by one with "+ Add Item".
              </p>
              <p className="mt-2">
                The import checks each cost code against your library and tells you how many lines were imported and which were skipped.
              </p>
            </>
          ),
          text: "import boq bill of quantities excel xlsx rate qty unit supply installation cost code items upload",
          sources: [
            "frontend/src/components/Sidebar.tsx:308",
            "frontend/src/app/c/[company_id]/d/budgeting/boq/page.tsx:1",
            "POST /apis/v3/budgeting/boq/import",
          ],
        },
        {
          q: "How do I set up a budget and cost codes?",
          a: (
            <>
              <p>
                You will need an active project selected and permission to edit finance or budgets.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/budget")}>
                  "Budget"
                </Link>
                , and click the "+ Set Budget" button.
              </p>
              <p className="mt-2">
                Choose the project and set budget limits across major expense heads like materials, labour, subcontractors, and equipment.
              </p>
              <p className="mt-2">
                Saving stores your head allocations and sets the cost baseline for the project.
              </p>
              <p className="mt-2">
                From there you can track committed costs versus actual spending variance across analytical reports.
              </p>
            </>
          ),
          text: "budget cost codes allocate head material labour subcon equipment variance committed actual",
          sources: [
            "frontend/src/components/Sidebar.tsx:308",
            "frontend/src/app/c/[company_id]/d/budget/page.tsx:1",
            "POST /apis/v3/budgeting/allocation",
          ],
        },
        {
          q: "How do I plan tasks and view the Gantt chart?",
          a: (
            <>
              <p>
                You will need an active project selected and permission to view planning.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Projects & Planning", and select{" "}
                <Link className="help-link" href={c(companyId, "/d/planning")}>
                  "Planning"
                </Link>
                . Choose the "WBS Tasks" tab.
              </p>
              <p className="mt-2">
                Enter the task name, start date, and duration in days, with optional parent tasks for hierarchy, priority, assigned teammate, and linked BOQ items.
              </p>
              <p className="mt-2">
                Clicking "Save WBS Task" adds the task to your schedule and displays its interactive bar on the Gantt timeline.
              </p>
              <p className="mt-2">
                Link dependencies between tasks to automatically calculate your critical path and schedule float.
              </p>
            </>
          ),
          text: "planning tasks gantt chart schedule duration start date wbs cpm critical path dependencies",
          sources: [
            "frontend/src/components/Sidebar.tsx:113",
            "frontend/src/app/c/[company_id]/d/planning/gantt/page.tsx:1",
            "POST /apis/v3/planning/tasks",
          ],
        },
        {
          q: "What are milestones, baseline and lookahead?",
          a: (
            <>
              <p>
                You will need a planning schedule set up for your selected project.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/planning")}>
                  "Planning"
                </Link>
                , and choose the "Milestones", "Baseline", or "14-Day Lookahead" tab.
              </p>
              <p className="mt-2">
                Enter the milestone name, target date, and type (such as start, inspection, critical, payment, or handover).
              </p>
              <p className="mt-2">
                Clicking "Save Milestone" records key dates, while setting a baseline creates a frozen snapshot of your schedule to track project slippage.
              </p>
              <p className="mt-2">
                Use the lookahead view to review short-term execution commitments with site supervisors.
              </p>
            </>
          ),
          text: "milestones baseline lookahead slippage schedule snapshot critical handover payment inspection",
          sources: [
            "frontend/src/components/Sidebar.tsx:113",
            "frontend/src/app/c/[company_id]/d/planning/gantt/page.tsx:1",
            "POST /apis/v3/planning/milestones",
          ],
        },
        {
          q: "How do I record a Daily Progress Report (DPR)?",
          a: (
            <>
              <p>
                You will need an active project selected, and the entry date must fall within your company's allowed back-dating window.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Site Operations", and select{" "}
                <Link className="help-link" href={c(companyId, "/d/dpr")}>
                  "DPR"
                </Link>
                . Click "+ Create DPR".
              </p>
              <p className="mt-2">
                Enter the report date and executed quantity, with optional task links, weather conditions, worker counts, consumed materials, site photos, and notes.
              </p>
              <p className="mt-2">
                Saving records the daily log, updates cumulative project progress, and draws down warehouse stock for materials consumed.
              </p>
              <p className="mt-2">
                Review daily site logs on the dashboard summary or export clean CSV reports for your client.
              </p>
            </>
          ),
          text: "dpr daily progress report site log weather workers executed qty materials consumed photos",
          sources: [
            "frontend/src/components/Sidebar.tsx:151",
            "frontend/src/app/c/[company_id]/d/dpr/page.tsx:1",
            "POST /apis/v3/dpr",
          ],
        },
      ],
    },
    {
      id: "procurement-materials",
      title: "Procurement & Materials",
      description: "Material indents, purchase orders, goods receipts, and 3-way matching.",
      icon: "trolley",
      items: [
        {
          q: "How does indent to PO to GRN to three-way match work?",
          a: (
            <>
              <p>
                You will need active vendors in your library and permission to view procurement.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Procurement & Materials", and select{" "}
                <Link className="help-link" href={c(companyId, "/d/three-way")}>
                  "Three-Way Match"
                </Link>
                .
              </p>
              <p className="mt-2">
                The lifecycle flows from site indent to approved PO, goods receipt at site, and vendor bill entry, where three-way match reconciles ordered rates, accepted quantities, and invoiced totals.
              </p>
              <p className="mt-2">
                Loading the comparison highlights discrepancies in red whenever quantities or prices exceed your configured tolerance thresholds.
              </p>
              <p className="mt-2">
                Approve fully matched bills for payment release, or raise debit notes for material shortfalls.
              </p>
            </>
          ),
          text: "procurement workflow indent po grn three way match reconciliation goods receipt purchase order invoice",
          sources: [
            "frontend/src/components/Sidebar.tsx:237",
            "frontend/src/app/c/[company_id]/d/three-way/page.tsx:1",
            "GET /apis/v3/three-way/pos/{company_id}",
          ],
        },
        {
          q: "How do I create a purchase order?",
          a: (
            <>
              <p>
                The supplier must be registered as a vendor in your library first.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Procurement & Materials", select{" "}
                <Link className="help-link" href={c(companyId, "/d/procurement")}>
                  "Procurement"
                </Link>
                , choose the "Purchase Orders" tab, and click "+ Purchase Order".
              </p>
              <p className="mt-2">
                Select the vendor, enter the PO number and date, and add line items with quantities, units, and unit rates, along with optional GST rates, delivery address, payment terms, and remarks.
              </p>
              <p className="mt-2">
                Saving creates the order in pending status, and clicking the approve action authorizes the order for delivery.
              </p>
              <p className="mt-2">
                From there you can receive delivered consignments against this approved order under the GRN tab.
              </p>
            </>
          ),
          text: "create purchase order po vendor supplier rate items gst delivery terms approve procurement",
          sources: [
            "frontend/src/components/Sidebar.tsx:229",
            "frontend/src/app/c/[company_id]/d/procurement/page.tsx:1",
            "POST /apis/v3/procurement/pos",
            "POST /apis/v3/procurement/pos/{po_id}/approve",
          ],
        },
        {
          q: "How do I run a Request for Quotation (RFQ)?",
          a: (
            <>
              <p>
                You will need suppliers registered in your library with email addresses or phone numbers.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/procurement")}>
                  "Procurement"
                </Link>
                , open RFQ Management, and click "+ Create RFQ".
              </p>
              <p className="mt-2">
                Enter the RFQ title, due date, participating vendors, and material line items with required quantities and specifications.
              </p>
              <p className="mt-2">
                Saving publishes the package and creates comparative bid entry sheets.
              </p>
              <p className="mt-2">
                Record supplier price responses to view a side-by-side commercial comparison and convert the winning bid into a purchase order.
              </p>
            </>
          ),
          text: "rfq request for quotation vendor comparison bid evaluation commercial procurement tender",
          sources: [
            "frontend/src/components/Sidebar.tsx:229",
            "frontend/src/app/c/[company_id]/d/procurement/rfq/page.tsx:1",
            "POST /apis/v3/procurement/rfq",
          ],
        },
        {
          q: "How do I manage inventory and warehouse?",
          a: (
            <>
              <p>
                You will need warehouse locations and materials set up for your project.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Procurement & Materials", and select{" "}
                <Link className="help-link" href={c(companyId, "/materials")}>
                  "Materials & Stock"
                </Link>
                .
              </p>
              <p className="mt-2">
                Select the material, source warehouse or project, destination, and transfer quantity.
              </p>
              <p className="mt-2">
                Posting a movement records the stock transaction and updates available and on-hand balances with negative stock protection.
              </p>
              <p className="mt-2">
                Track minimum reorder alerts and compare ongoing consumption against project estimates.
              </p>
            </>
          ),
          text: "inventory warehouse stock material transfer issue receipt stock balance negative stock lock",
          sources: [
            "frontend/src/components/Sidebar.tsx:245",
            "frontend/src/app/c/[company_id]/materials/page.tsx:1",
            "POST /apis/v3/procurement/transactions",
          ],
        },
      ],
    },
    {
      id: "finance-billing",
      title: "Finance & Billing",
      description: "Vendor bills, subcontractor RA bills, payments, cashbook, and P&L.",
      icon: "currency_rupee",
      items: [
        {
          q: "How do I record a vendor bill?",
          a: (
            <>
              <p>
                You will need an active project selected and the vendor registered in your library.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Finance & Billing", select{" "}
                <Link className="help-link" href={c(companyId, "/d/billing")}>
                  "Billing & Invoices"
                </Link>
                , and click "+ Submit RA Bill".
              </p>
              <p className="mt-2">
                Select the vendor, enter the invoice number, invoice date, type ("material" or "subcon"), and the subtotal amount, with optional GST rates, deduction amounts (TDS and retention), and pre-tax deduction options.
              </p>
              <p className="mt-2">
                Saving creates the bill in pending status and calculates statutory deductions automatically.
              </p>
              <p className="mt-2">
                From there you can perform three-way matching against purchase orders and goods receipts before approving for payment.
              </p>
            </>
          ),
          text: "record vendor bill invoice material subtotal gst tds retention statutory deductions",
          sources: [
            "frontend/src/components/Sidebar.tsx:283",
            "frontend/src/app/c/[company_id]/d/billing/page.tsx:1",
            "POST /apis/v3/billing/bills",
          ],
        },
        {
          q: "How do subcontractor work orders and RA bills work (TDS and retention)?",
          a: (
            <>
              <p>
                You will need the subcontractor registered in your library with an active work order agreement.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Finance & Billing", select{" "}
                <Link className="help-link" href={c(companyId, "/d/billing")}>
                  "Billing & Invoices"
                </Link>
                , and choose the "RA Bills (Subcon)" tab. Click "+ Submit RA Bill".
              </p>
              <p className="mt-2">
                Choose the subcontractor, enter the invoice number, date, gross certified amount, and GST rate, with configured retention percentage and TDS tax section.
              </p>
              <p className="mt-2">
                Saving with invoice type "subcon" calculates retention and TDS on the pre-tax base according to statutory rules.
              </p>
              <p className="mt-2">
                Track retained balances in the retention register for release upon completion of the defect liability period.
              </p>
            </>
          ),
          text: "subcontractor ra bill running account work order tds retention defect liability certified amount",
          sources: [
            "frontend/src/components/Sidebar.tsx:283",
            "frontend/src/app/c/[company_id]/d/billing/page.tsx:1",
            "POST /apis/v3/billing/bills",
          ],
        },
        {
          q: "How do I make a payment or raise a payment request?",
          a: (
            <>
              <p>
                You will need a bank or cash account set up first, and permission to edit finance.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/finance")}>
                  "Finance"
                </Link>
                , choose the "Payment Requests" tab, and click "+ Create Payment Request".
              </p>
              <p className="mt-2">
                Fill in the party, whether the payment is "in" for client receipts or "out" for vendor payouts, the amount, the payment method (Bank Transfer, Cheque, UPI, or Cash), and the payment date.
              </p>
              <p className="mt-2">
                Saving records the transaction against that party and updates the account balance.
              </p>
              <p className="mt-2">
                From there you can link the payout to open vendor bills or review updated party statement balances.
              </p>
            </>
          ),
          text: "make payment payment request voucher bank transfer cheque cashbook payout receipt ledger",
          sources: [
            "frontend/src/components/Sidebar.tsx:276",
            "frontend/src/app/c/[company_id]/d/finance/page.tsx:1",
            "POST /apis/v3/finance/payments",
          ],
        },
        {
          q: "What is the cashbook?",
          a: (
            <>
              <p>
                You will need team members assigned site cash handling limits.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/finance")}>
                  "Finance"
                </Link>
                , and choose the "Cashbook" tab.
              </p>
              <p className="mt-2">
                Use the cashbook for peer-to-peer transfers between team members, petty cash expenses, receipt image uploads, and daily site cash reconciliations.
              </p>
              <p className="mt-2">
                Submitting a transfer debits the sender's wallet balance and credits the recipient immediately.
              </p>
              <p className="mt-2">
                Settle site expenses against approved expense vouchers and maintain daily cash tallies.
              </p>
            </>
          ),
          text: "cashbook petty cash p2p transfer site expenses cash wallet peer to peer finance",
          sources: [
            "frontend/src/components/Sidebar.tsx:276",
            "frontend/src/app/c/[company_id]/d/finance/page.tsx:1",
            "POST /apis/v3/finance/cashbook/p2p",
          ],
        },
        {
          q: "How do multi-level approvals work?",
          a: (
            <>
              <p>
                You will need permission to manage settings or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Multi Level Approval" tab. Click "Publish Rule Block".
              </p>
              <p className="mt-2">
                Select the module (such as purchase orders, bills, indents, or payments), set the minimum amount threshold, and arrange the approval role sequence from Level 1 upwards.
              </p>
              <p className="mt-2">
                Saving publishes the approval hierarchy for amount-based routing.
              </p>
              <p className="mt-2">
                Note: The approval rules defined here are not applied to transactions that fall outside the configured threshold.
              </p>
              <p className="mt-2">
                Transactions meeting the threshold trigger review alerts to authorized approvers before advancing to execution.
              </p>
            </>
          ),
          text: "multi level approvals workflow rules hierarchy threshold po bill indent authorization",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "POST /apis/v3/settings/approval-rules/{company_id}",
          ],
        },
        {
          q: "How do I see a project profit and loss?",
          a: (
            <>
              <p>
                You will need permission to view company reports.
              </p>
              <p className="mt-2">
                Open the sidebar, and select{" "}
                <Link className="help-link" href={c(companyId, "/analytics")}>
                  "Analytics"
                </Link>
                .
              </p>
              <p className="mt-2">
                Project profit is calculated by subtracting direct costs (materials issued, labour paid, subcontractor certified bills, and equipment hire) and indirect overheads from certified revenue.
              </p>
              <p className="mt-2">
                Opening the dashboard displays real-time gross margin percentages, category expense distributions, and budget variance summaries.
              </p>
              <p className="mt-2">
                Drill down into individual cost items through the detailed cost code expense reports.
              </p>
            </>
          ),
          text: "profit and loss pnl analytics revenue expenses direct costs gross margin financial reports",
          sources: [
            "frontend/src/components/Sidebar.tsx:82",
            "frontend/src/app/c/[company_id]/analytics/page.tsx:1",
            "GET /apis/v3/analytics/company/{company_id}",
          ],
        },
      ],
    },
    {
      id: "workforce-hr",
      title: "Workforce & HR",
      description: "Employee onboarding, site attendance, labour muster, payroll, and leave.",
      icon: "group",
      items: [
        {
          q: "How do I add employees?",
          a: (
            <>
              <p>
                You will need permission to edit payroll or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Finance & Billing", select{" "}
                <Link className="help-link" href={c(companyId, "/d/hr")}>
                  "HR & Staff"
                </Link>
                , and click "+ Add Staff".
              </p>
              <p className="mt-2">
                Enter the employee's full name, monthly salary, and job designation, with optional project assignments, phone, email, UAN for provident fund, PAN, bank details, and joining date.
              </p>
              <p className="mt-2">
                Saving creates the employee profile and structures their monthly earnings components.
              </p>
              <p className="mt-2">
                Configure geofenced mobile attendance punching or biometric logging for daily tracking.
              </p>
            </>
          ),
          text: "add employee staff hr onboarding salary designation uan pan bank details",
          sources: [
            "frontend/src/components/Sidebar.tsx:300",
            "frontend/src/app/c/[company_id]/d/hr/page.tsx:1",
            "POST /apis/v3/hr/employees",
          ],
        },
        {
          q: "How does site attendance and geofencing work?",
          a: (
            <>
              <p>
                You will need project GPS coordinates and a boundary radius configured in project settings.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Site Operations", and select{" "}
                <Link className="help-link" href={c(companyId, "/d/attendance")}>
                  "Attendance"
                </Link>
                .
              </p>
              <p className="mt-2">
                Mobile punch requests record real-time GPS coordinates, which the system validates against the project location to flag any out-of-boundary punches.
              </p>
              <p className="mt-2">
                Saving a punch records the exact time, punch type (in or out), and location verification status.
              </p>
              <p className="mt-2">
                Verified attendance logs feed directly into your monthly payroll calculations.
              </p>
            </>
          ),
          text: "site attendance geofencing gps radius punch in punch out mobile face recognition haversine",
          sources: [
            "frontend/src/components/Sidebar.tsx:183",
            "frontend/src/app/c/[company_id]/d/attendance/page.tsx:1",
            "POST /apis/v3/hr/attendance/punch",
          ],
        },
        {
          q: "How do timesheets and labour records work?",
          a: (
            <>
              <p>
                You will need active subcontractor parties and daily labour deployment at the site.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/labour")}>
                  "Labour"
                </Link>
                , choose the "Muster Roll" tab, and click "+ Add Muster".
              </p>
              <p className="mt-2">
                Select the project, date, trade category (such as mason, carpenter, or helper), and worker headcount, along with optional overtime hours and subcontractor assignments.
              </p>
              <p className="mt-2">
                Saving logs the daily shift counts and updates your statutory labour compliance registers.
              </p>
              <p className="mt-2">
                Compare actual worker deployment against daily progress reports and productivity benchmarks.
              </p>
            </>
          ),
          text: "labour management muster roll timesheet headcount trade mason carpenter bocw overtime",
          sources: [
            "frontend/src/components/Sidebar.tsx:175",
            "frontend/src/app/c/[company_id]/d/labour/page.tsx:1",
            "POST /apis/v3/labour/muster-roll",
          ],
        },
        {
          q: "How do I run payroll and export payslips?",
          a: (
            <>
              <p>
                You will need active employees and recorded monthly attendance logs.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Finance & Billing", select{" "}
                <Link className="help-link" href={c(companyId, "/d/hr")}>
                  "HR & Staff"
                </Link>
                , choose the "Payroll Runs" tab, and click "Compute Payroll".
              </p>
              <p className="mt-2">
                Select the payroll month and year.
              </p>
              <p className="mt-2">
                Running payroll calculates gross earnings (basic salary, HRA, allowances) minus statutory deductions (EPF, ESI, professional tax, and unpaid leave days) and finalizes the period.
              </p>
              <p className="mt-2">
                Export bank transfer payout sheets and bulk PDF payslips for your team.
              </p>
            </>
          ),
          text: "run payroll payslips salary epf esi pt deductions basic hra bank payout export compute",
          sources: [
            "frontend/src/components/Sidebar.tsx:300",
            "frontend/src/app/c/[company_id]/d/hr/page.tsx:1",
            "POST /apis/v3/hr/payroll/run",
          ],
        },
        {
          q: "How do leave templates and per-employee balances work?",
          a: (
            <>
              <p>
                You will need permission to edit payroll or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/hr")}>
                  "HR & Staff"
                </Link>
                , and choose the "Leave Management" tab.
              </p>
              <p className="mt-2">
                Create company leave templates with annual allowances and carry-forward rules for casual, sick, and earned leaves.
              </p>
              <p className="mt-2">
                Saving allocates initial leave balances to enrolled employees.
              </p>
              <p className="mt-2">
                Review and approve leave applications, with unapproved absences automatically factored into monthly payroll calculations.
              </p>
            </>
          ),
          text: "leave management templates quota sick casual earned carry forward balance hr",
          sources: [
            "frontend/src/components/Sidebar.tsx:300",
            "frontend/src/app/c/[company_id]/d/hr/page.tsx:1",
            "POST /apis/v3/hr/leave-templates/{company_id}",
          ],
        },
      ],
    },
    {
      id: "plant-equipment",
      title: "Plant & Equipment",
      description: "Fleet tracking, site deployments, fuel logs, and production batches.",
      icon: "truck",
      items: [
        {
          q: "How do I register and track equipment?",
          a: (
            <>
              <p>
                You will need permission to edit equipment or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/equipment")}>
                  "Equipment"
                </Link>
                , and click "+ Add Equipment".
              </p>
              <p className="mt-2">
                Enter the equipment name, asset code, category (such as earthmoving, concreting, or crane), and ownership type ("Owned" or "Hired"), with optional registration number, hourly hire rate, and current meter reading.
              </p>
              <p className="mt-2">
                Saving registers the machinery in "available" status.
              </p>
              <p className="mt-2">
                From there you can deploy the registered asset to any active construction site.
              </p>
            </>
          ),
          text: "register equipment asset fleet machinery owned hired excavator crane meter reading",
          sources: [
            "frontend/src/components/Sidebar.tsx:199",
            "frontend/src/app/c/[company_id]/d/equipment/page.tsx:1",
            "POST /apis/v3/equipment",
          ],
        },
        {
          q: "How do site deployments and log sheets work?",
          a: (
            <>
              <p>
                You will need the equipment asset registered and currently in "available" status.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/equipment")}>
                  "Equipment"
                </Link>
                , select the asset, and click "Deploy to Site".
              </p>
              <p className="mt-2">
                Select the target project and deployment start date, with optional operator name and initial odometer reading.
              </p>
              <p className="mt-2">
                Saving updates the asset status to "deployed" and creates an active deployment record.
              </p>
              <p className="mt-2">
                Track daily operating hours and fuel logs, and record the return upon project demobilization.
              </p>
            </>
          ),
          text: "equipment deployment deploy project site log sheet operator odometer return machinery",
          sources: [
            "frontend/src/components/Sidebar.tsx:199",
            "frontend/src/app/c/[company_id]/d/equipment/page.tsx:1",
            "POST /apis/v3/equipment/{equipment_id}/deploy",
          ],
        },
        {
          q: "How do I track fuel logs and efficiency?",
          a: (
            <>
              <p>
                The equipment must be actively deployed to a project.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/equipment")}>
                  "Equipment"
                </Link>
                , select the asset, and click "Refuel".
              </p>
              <p className="mt-2">
                Enter the project, log date, dispensed liters, and cost per liter, with optional meter readings and fuel bill receipt photos.
              </p>
              <p className="mt-2">
                Saving logs the fuel expense against the project and computes running efficiency metrics.
              </p>
              <p className="mt-2">
                Review operating fuel expenditure on your equipment profitability reports.
              </p>
            </>
          ),
          text: "fuel log equipment diesel efficiency liters cost per liter odometer running hours",
          sources: [
            "frontend/src/components/Sidebar.tsx:199",
            "frontend/src/app/c/[company_id]/d/equipment/page.tsx:1",
            "POST /apis/v3/equipment/{equipment_id}/fuel",
          ],
        },
        {
          q: "How do I manage production batches and recipes?",
          a: (
            <>
              <p>
                You will need the production module enabled on your manufacturing or batching plant project.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Site Operations", select{" "}
                <Link className="help-link" href={c(companyId, "/d/production")}>
                  "Production"
                </Link>
                , and click "+ New Recipe".
              </p>
              <p className="mt-2">
                Enter the recipe code, product name, mix type (such as concrete, asphalt, or precast), unit of measurement, and the proportioned raw materials list.
              </p>
              <p className="mt-2">
                Saving stores the mix design, and executing batches automatically deducts cement, aggregates, and admixtures from plant inventory.
              </p>
              <p className="mt-2">
                Generate batch delivery challans for site dispatch and transit tracking.
              </p>
            </>
          ),
          text: "production batch recipe concrete rmc design mix auto consumption dispatch plant",
          sources: [
            "frontend/src/components/Sidebar.tsx:207",
            "frontend/src/app/c/[company_id]/d/production/page.tsx:1",
            "POST /apis/v3/production/recipes",
          ],
        },
      ],
    },
    {
      id: "sales-crm",
      title: "Sales & CRM",
      description: "Lead capture, client quotations, pipeline stages, and rate card library.",
      icon: "sparkles",
      items: [
        {
          q: "How do I capture leads and manage the sales pipeline?",
          a: (
            <>
              <p>
                You will need permission to view CRM or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Sales & CRM", select{" "}
                <Link className="help-link" href={c(companyId, "/d/crm")}>
                  "CRM & Leads"
                </Link>
                , and click "New Lead +".
              </p>
              <p className="mt-2">
                Enter the lead title, project type (such as commercial, residential, or infrastructure), contact person, and phone number, with optional client name, estimated value, source, and pipeline stage.
              </p>
              <p className="mt-2">
                Saving creates the opportunity card on your sales pipeline board.
              </p>
              <p className="mt-2">
                Move cards across stages from initial inquiry to site visit, proposal, and won deals, and prepare client quotations directly from the lead.
              </p>
            </>
          ),
          text: "crm leads sales pipeline kanban opportunity contact client value commercial residential",
          sources: [
            "frontend/src/components/Sidebar.tsx:340",
            "frontend/src/app/c/[company_id]/d/crm/page.tsx:1",
            "POST /apis/v3/crm/leads",
          ],
        },
        {
          q: "How do I create client quotations and cost estimates?",
          a: (
            <>
              <p>
                You will need a lead created and standard rate cards configured in your library.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/crm")}>
                  "CRM & Leads"
                </Link>
                , open the lead details, switch to the "Quotation" tab, and click "New Quotation +".
              </p>
              <p className="mt-2">
                Enter the quotation subject, quote number, and line items with quantities, units, and rates, along with optional GST rates, markup percentages, discounts, and payment terms.
              </p>
              <p className="mt-2">
                Saving creates the estimate and generates a branded quotation document.
              </p>
              <p className="mt-2">
                Once approved by the client, convert the accepted quotation directly into an active project and billing invoice.
              </p>
            </>
          ),
          text: "create client quotation estimate proposal rate items markup discount convert invoice",
          sources: [
            "frontend/src/components/Sidebar.tsx:340",
            "frontend/src/app/c/[company_id]/d/crm/page.tsx:1",
            "POST /apis/v3/crm/leads/{lead_id}/quotations",
          ],
        },
        {
          q: "How does the Rate Card Library work?",
          a: (
            <>
              <p>
                You will need permission to edit library items or hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/d/library")}>
                  "Library"
                </Link>
                , and choose the "Rate Library" tab. Click "+ Add to Library".
              </p>
              <p className="mt-2">
                Enter the item name, code, unit of measurement, standard cost rate, and selling price, with optional category and description notes.
              </p>
              <p className="mt-2">
                Saving registers the master item in your company price database.
              </p>
              <p className="mt-2">
                Use your rate card library to automatically populate BOQ line items and client quotation estimates with preset rates.
              </p>
            </>
          ),
          text: "rate card library standard unit price cost rate selling rate master rates presets",
          sources: [
            "frontend/src/components/Sidebar.tsx:354",
            "frontend/src/app/c/[company_id]/d/library/page.tsx:1",
            "POST /apis/v3/library/rates",
          ],
        },
      ],
    },
    {
      id: "integrations",
      title: "Integrations & Backup",
      description: "Tally Prime XML sync, Zoho Books, Google Drive backup, and BI feeds.",
      icon: "settings",
      items: [
        {
          q: "How do I connect Tally Prime?",
          a: (
            <>
              <p>
                You will need the owner role, and Tally Prime running on your accounting computer with its XML server enabled.
              </p>
              <p className="mt-2">
                Open the sidebar, select{" "}
                <Link className="help-link" href={c(companyId, "/d/finance")}>
                  "Finance"
                </Link>
                , and choose the "Tally Sync" tab. Click "Connect Tally".
              </p>
              <p className="mt-2">
                Enter your company name in Tally, server port, or your desktop sync agent connection token.
              </p>
              <p className="mt-2">
                Saving the connection allows you to export approved vouchers and generate XML payloads with automatic voucher deduplication.
              </p>
              <p className="mt-2">
                Sync ledgers, cost centers, and vendor bills directly into your Tally Prime accounts.
              </p>
            </>
          ),
          text: "tally prime sync xml export accounting ledger cost centre voucher deduplication integration connect",
          sources: [
            "frontend/src/components/Sidebar.tsx:276",
            "frontend/src/app/c/[company_id]/d/finance/page.tsx:1",
            "POST /apis/v3/tally/connections",
          ],
        },
        {
          q: "How do I connect Zoho Books?",
          a: (
            <>
              <p>
                You will need an active Zoho Books organization and administrator access.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Integrations" tab. Under Zoho Books, click "Connect".
              </p>
              <p className="mt-2">
                Authorize the connection through the Zoho sign-in window to link your accounting organization.
              </p>
              <p className="mt-2">
                Saving the authorization enables automatic synchronization of approved vendor bills and customer invoices with your chart of accounts.
              </p>
              <p className="mt-2">
                Check real-time sync status badges directly on your bills and invoices registers.
              </p>
            </>
          ),
          text: "zoho books connect oauth sync invoices bills chart of accounts integration",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "GET /apis/v3/integrations/zoho-books/authorize",
          ],
        },
        {
          q: "How do Google Drive backup and Google Sheets export work?",
          a: (
            <>
              <p>
                You will need a Google account authorized by your company administrator.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Integrations" tab. Under Google Drive, click "Connect".
              </p>
              <p className="mt-2">
                Connect your account to enable daily automated backups of your documents and databases, along with one-click spreadsheet exports for attendance and payroll registers.
              </p>
              <p className="mt-2">
                Authorizing links your designated Drive folder for encrypted automated archives.
              </p>
              <p className="mt-2">
                Run a test backup to confirm destination folder synchronization.
              </p>
            </>
          ),
          text: "google drive backup google sheets export cloud backup automated archive spreadsheets integrations",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "GET /apis/v3/integrations/google-drive/authorize",
          ],
        },
        {
          q: "How do I access BI data feeds via API Key?",
          a: (
            <>
              <p>
                You will need an enterprise plan or BI integration enabled, and hold the owner role.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Setup & Config", select{" "}
                <Link className="help-link" href={c(companyId, "/settings")}>
                  "Settings"
                </Link>
                , and choose the "Integrations" tab. Under BI Data Export, enter a key label and click "Create".
              </p>
              <p className="mt-2">
                Provide a key name and choose an expiration period (such as 30 days, 90 days, 365 days, or never).
              </p>
              <p className="mt-2">
                Saving generates a secure bearer API token for live streaming into Power BI, Tableau, or custom analytics dashboards.
              </p>
              <p className="mt-2">
                Use your key to connect live data feeds for budget variance, inventory levels, and task progress.
              </p>
            </>
          ),
          text: "bi data feed api key power bi tableau live data streaming analytics export integration create",
          sources: [
            "frontend/src/components/Sidebar.tsx:378",
            "frontend/src/app/c/[company_id]/settings/page.tsx:1",
            "POST /apis/v3/integrations/bi/companies/{company_id}/keys",
          ],
        },
      ],
    },
    {
      id: "quality-safety",
      title: "Quality & Safety",
      description: "Inspection checklists, NCR resolution, incident logs, and site safety permits.",
      icon: "check_circle",
      items: [
        {
          q: "How do I perform quality inspections and manage NCRs?",
          a: (
            <>
              <p>
                You will need a quality checklist template set up and permission to edit quality records.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Site Operations", select{" "}
                <Link className="help-link" href={c(companyId, "/d/quality")}>
                  "Quality & NCR"
                </Link>
                , and click "+ New Inspection".
              </p>
              <p className="mt-2">
                Select the project, checklist template, inspection title, and date, with optional tower or location details, checklist photos, and item remarks.
              </p>
              <p className="mt-2">
                Saving logs the inspection, and any failed checklist items automatically raise a non-conformance report assigned to the responsible contractor.
              </p>
              <p className="mt-2">
                Track contractor corrective actions and re-inspect items before closing the report.
              </p>
            </>
          ),
          text: "quality inspections ncr non conformance report checklist pre pour tolerance site safety",
          sources: [
            "frontend/src/components/Sidebar.tsx:159",
            "frontend/src/app/c/[company_id]/d/quality/page.tsx:1",
            "POST /apis/v3/quality/inspections",
          ],
        },
        {
          q: "How do I report safety incidents and issue work permits?",
          a: (
            <>
              <p>
                You will need an active project selected and permission to edit safety records.
              </p>
              <p className="mt-2">
                Open the sidebar, navigate to "Site Operations", select{" "}
                <Link className="help-link" href={c(companyId, "/d/safety")}>
                  "Safety"
                </Link>
                , and click "+ Report Incident".
              </p>
              <p className="mt-2">
                Enter the incident title, type (such as near miss, first aid, lost time, or dangerous occurrence), severity level, description, reporting user, and incident date, with optional location tags, root cause details, and site photos.
              </p>
              <p className="mt-2">
                Saving logs the incident in open status and sends high-severity alerts to safety officers immediately.
              </p>
              <p className="mt-2">
                Record corrective actions and complete the closeout review to resolve the incident.
              </p>
            </>
          ),
          text: "safety incidents work permit near miss hazard lost time severity root cause safety officer",
          sources: [
            "frontend/src/components/Sidebar.tsx:167",
            "frontend/src/app/c/[company_id]/d/safety/page.tsx:1",
            "POST /apis/v3/safety/incidents",
          ],
        },
      ],
    },
  ];
}

export const HELP_CATEGORIES = getHelpCategories;

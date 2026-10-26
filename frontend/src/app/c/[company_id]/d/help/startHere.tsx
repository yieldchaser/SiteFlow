"use client";

import React from "react";
import Link from "next/link";
import type { HelpCategory } from "./helpContent";

function c(companyId: string, path: string): string {
  return `/c/${companyId}${path.startsWith("/") ? path : `/${path}`}`;
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal ml-5 mt-2 space-y-1.5">{children}</ol>;
}

/**
 * The guided setup for someone who has never used SiteFlow: what to set up,
 * in what order, and where each screen is. Every button and tab name here is
 * the label shown on screen.
 */
export function startHereCategory(companyId: string): HelpCategory {
  const L = ({ to, children }: { to: string; children: React.ReactNode }) => (
    <Link className="help-link" href={c(companyId, to)}>
      {children}
    </Link>
  );

  return {
    id: "start-here",
    title: "Start Here: Setting Up From Zero",
    description: "New to SiteFlow? Follow these steps in order. Each one links to the screen you need.",
    icon: "rocket",
    items: [
      {
        q: "I am new. In what order should I set things up?",
        a: (
          <>
            <p>
              Set things up in this order. Each step needs the one before it, so a project can use your cost
              codes, a bill can use your parties, and payroll can use your employees.
            </p>
            <Steps>
              <li>Company details, logo and signature (Settings, Company tab).</li>
              <li>Your office team and what each person can see (Settings, Team and Roles &amp; Access tabs).</li>
              <li>Payroll rules, holidays and weekly off (Settings, Payroll and Holiday &amp; Weekoff tabs).</li>
              <li>Libraries: cost codes, materials, parties (clients, vendors, subcontractors) and labour categories.</li>
              <li>Your first project.</li>
              <li>Add the client and vendors to that project.</li>
              <li>BOQ and budget for the project.</li>
              <li>Tasks and milestones (the schedule).</li>
              <li>Employees with their employee codes, and labour.</li>
              <li>Daily work: attendance, DPR, quality and safety.</li>
              <li>Buying material: indent, purchase order, goods receipt, vendor bill.</li>
              <li>Subcontractors: work order and RA bills.</li>
              <li>Billing the client and recording money in and out.</li>
              <li>Month end: payroll, statutory returns and reports.</li>
            </Steps>
            <p className="mt-2">The questions below walk through each step with the exact buttons to press.</p>
          </>
        ),
        text: "start new beginner order setup first steps checklist where to begin how to proceed getting started guide",
        sources: ["frontend/src/components/Sidebar.tsx:1"],
      },
      {
        q: "Step 1: How do I fill in my company details, logo and signature?",
        a: (
          <>
            <p>
              Open <L to="/settings">Settings</L> from the sidebar (under Setup &amp; Config). The Company tab opens
              first.
            </p>
            <Steps>
              <li>Under Company Details, enter the company name, phone, legal business name, GSTIN and primary address.</li>
              <li>Under Branding Assets, upload your logo, signature and company stamp.</li>
              <li>Press Save.</li>
            </Steps>
            <p className="mt-2">
              The logo, signature and stamp are printed on your purchase orders, bills and BOQ PDFs.
            </p>
          </>
        ),
        text: "company details gstin pan address logo signature stamp branding settings company tab letterhead",
        sources: ["frontend/src/app/c/[company_id]/settings/page.tsx:1"],
      },
      {
        q: "Step 2: How do I add my office team and decide what they can see?",
        a: (
          <>
            <p>
              Open <L to="/settings">Settings</L> and choose the Roles &amp; Access tab first.
            </p>
            <Steps>
              <li>
                Create a role for each kind of person, for example Site Engineer, Store Keeper, Accountant. Tick
                only the modules that role needs. Anything not ticked stays hidden.
              </li>
              <li>Go to the Team tab and add each person with their name, mobile number or email, and their role.</li>
              <li>Pick which projects they work on. They only see the projects you give them.</li>
            </Steps>
            <p className="mt-2">
              These are people who log in to SiteFlow. Site workers who never log in are added as employees or
              labour instead (see Step 9).
            </p>
          </>
        ),
        text: "team invite user login role permission access site engineer accountant store keeper restrict hide modules",
        sources: ["frontend/src/app/c/[company_id]/settings/page.tsx:1"],
      },
      {
        q: "Step 3: How do I set payroll rules, holidays and weekly off?",
        a: (
          <>
            <p>
              In <L to="/settings">Settings</L>:
            </p>
            <Steps>
              <li>Payroll tab: set PF and ESI percentages, the PF wage ceiling, salary templates and leave policies.</li>
              <li>
                Holiday &amp; Weekoff tab: choose the weekly off day (for example Sunday) and add festival holidays.
              </li>
            </Steps>
            <p className="mt-2">
              Payroll uses these to count working days in a month. If you skip this, every calendar day counts as
              a working day and salaries are split across the whole month.
            </p>
          </>
        ),
        text: "payroll settings pf esi salary template holiday weekly off sunday festival working days",
        sources: ["frontend/src/app/c/[company_id]/settings/page.tsx:1"],
      },
      {
        q: "Step 4: How do I create cost codes?",
        a: (
          <>
            <p>
              Open <L to="/cost-codes">Cost Codes</L> from the sidebar (under Procurement &amp; Materials). This opens
              the Cost Code Library tab of the Library.
            </p>
            <Steps>
              <li>Press + Add to Library.</li>
              <li>
                Enter the cost code (for example 03), a sub cost code if you split it further (for example 03.01),
                and a description (for example RCC Superstructure).
              </li>
              <li>Save. Repeat for each head of work.</li>
            </Steps>
            <p className="mt-2">
              A simple set that works for most building jobs: 01 Site preparation and earthwork, 02 Foundation, 03
              RCC, 04 Masonry and plaster, 05 MEP, 06 Finishing, 07 External works. Your BOQ items and budget are
              then tagged with these codes so cost reports group correctly.
            </p>
          </>
        ),
        text: "cost code create add sub cost code head of work library wbs code rcc masonry finishing",
        sources: ["frontend/src/app/c/[company_id]/d/library/page.tsx:1"],
      },
      {
        q: "Step 4 (continued): How do I add materials, clients, vendors and subcontractors?",
        a: (
          <>
            <p>
              All of these live in the <L to="/d/library">Library</L> (sidebar, under Setup &amp; Config). Each kind
              has its own tab along the top.
            </p>
            <Steps>
              <li>
                Material Category Library: add groups such as Cement, Steel, Aggregates, Electrical. Do this before
                materials.
              </li>
              <li>
                Material Library: press + Add to Library and enter the material name, unit (bag, MT, cum), category,
                HSN code, GST % and standard cost.
              </li>
              <li>
                Party Library: press + Add to Library. Enter the party name and choose the party type (Client,
                Supplier or Subcontractor), with phone, GSTIN, PAN, address and bank details. Bank details are used
                when you pay them.
              </li>
              <li>Workforce Library: add labour categories such as Mason, Helper, Carpenter, Bar Bender.</li>
            </Steps>
            <p className="mt-2">
              You add each party once here and then pick it on any project, purchase order or bill.
            </p>
          </>
        ),
        text: "material library add material unit hsn gst category party library client vendor supplier subcontractor add party workforce labour category mason helper",
        sources: ["frontend/src/app/c/[company_id]/d/library/page.tsx:1"],
      },
      {
        q: "Step 5: How do I create my first project?",
        a: (
          <>
            <p>
              Open <L to="/projects">Projects</L> from the sidebar and press + Create Project. The form has three
              short pages.
            </p>
            <Steps>
              <li>
                Page one: project name, project code, address, city, state, and site coordinates. The state is
                required because it decides GST on bills. The coordinates are the site location used for mobile
                attendance.
              </li>
              <li>
                Page two: stage, category (residential, commercial and so on), project value, attendance radius in
                metres, planned start and end dates, and scope of work.
              </li>
              <li>Page three: add the team members who work on this project, then create it.</li>
            </Steps>
            <p className="mt-2">
              To work inside a project, click it in the Projects list. Its own tabs appear along the top: Dashboard,
              BOQ, Party, Transaction, To Do, Task, Attendance, Material, Subcon, Files, MOM, Equipment and
              Inspection.
            </p>
          </>
        ),
        text: "create project new site wizard project code state coordinates attendance radius stage value start date open project tabs",
        sources: ["frontend/src/app/c/[company_id]/projects/page.tsx:700"],
      },
      {
        q: "Step 6: How do I add the client and vendors to a project?",
        a: (
          <>
            <p>
              Open the project from <L to="/projects">Projects</L> and go to its Party tab.
            </p>
            <Steps>
              <li>Press + Add Party and pick the client, suppliers and subcontractors from your Party Library.</li>
              <li>If a party is not in the library yet, use + New Party to create it right there.</li>
            </Steps>
            <p className="mt-2">
              Only parties added to the project can be billed or paid on that project. The Party tab then shows, for
              each one, how much is to be received or paid and any advance given.
            </p>
          </>
        ),
        text: "add client to project add vendor party tab project party bill client cannot select party",
        sources: ["frontend/src/app/c/[company_id]/p/[project_id]/party/page.tsx:1"],
      },
      {
        q: "Step 7: How do I enter the BOQ and set the budget?",
        a: (
          <>
            <p>
              <strong>BOQ.</strong> Open the project and go to its BOQ tab.
            </p>
            <Steps>
              <li>Press + BOQ, give it a title (for example BOQ for Tower A) and choose the client.</li>
              <li>Open the BOQ you created.</li>
              <li>
                Either press + Add Item and type each line (section, item, cost code, unit, quantity, rate), or use
                Import Excel items into this BOQ to upload a .xlsx or .xlsm sheet.
              </li>
            </Steps>
            <p className="mt-2">
              <strong>Budget.</strong> Open <L to="/d/budget">Budget</L> from the sidebar (under Finance &amp;
              Billing) and press + Set Budget. Enter the budget for material, labour, subcontractor and equipment.
              The page then compares the budget with what is committed in purchase and work orders and what has
              actually been billed.
            </p>
          </>
        ),
        text: "boq bill of quantities add item import excel xlsx budget set budget material labour subcontractor equipment committed actual",
        sources: ["frontend/src/app/c/[company_id]/p/[project_id]/boq/page.tsx:404", "frontend/src/app/c/[company_id]/d/budget/page.tsx:1"],
      },
      {
        q: "Step 8: How do I make the schedule (tasks and milestones)?",
        a: (
          <>
            <p>
              Open <L to="/d/planning">Planning</L> from the sidebar with your project selected at the top.
            </p>
            <Steps>
              <li>
                In the WBS Tasks tab, use Create WBS Task: task name, duration in days, start date and priority.
              </li>
              <li>
                Use Link CPM Predecessors to say which task must finish before another starts. Dates then move
                together when one slips.
              </li>
              <li>Add key dates in the Milestones tab, and freeze the plan in the Baseline tab once agreed.</li>
              <li>The 14-Day Lookahead tab shows what must start in the next two weeks.</li>
            </Steps>
          </>
        ),
        text: "schedule tasks wbs create task predecessor link milestones baseline lookahead gantt planning",
        sources: ["frontend/src/app/c/[company_id]/d/planning/page.tsx:1"],
      },
      {
        q: "Step 9: How do I register an employee and give them an employee code?",
        a: (
          <>
            <p>
              Open <L to="/d/hr">HR &amp; Staff</L> from the sidebar (under Finance &amp; Billing).
            </p>
            <Steps>
              <li>Press + Add Staff. The Add New Employee form opens.</li>
              <li>
                Enter full name, employee code, designation, department, mobile, basic salary, HRA, other allowances,
                monthly TDS and date of joining.
              </li>
              <li>
                Choose your own code pattern and keep to it, for example SIC-001, SIC-002. The code appears on
                attendance, payslips and the biometric machine list.
              </li>
              <li>Press Save Employee.</li>
            </Steps>
            <p className="mt-2">
              Daily-wage labour supplied by a labour contractor is not added here. Record their daily headcount
              under <L to="/d/subcon">Subcontractors</L>, Daily Attendance tab, against that contractor.
            </p>
          </>
        ),
        text: "add employee register staff employee code salary basic hra designation department date of joining add staff hr",
        sources: ["frontend/src/app/c/[company_id]/d/hr/page.tsx:1"],
      },
      {
        q: "Step 10: How is daily attendance marked?",
        a: (
          <>
            <p>There are three ways. Use whichever suits each site.</p>
            <Steps>
              <li>
                <strong>Phone, at site.</strong> Open <L to="/d/attendance">Attendance</L>, pick the employee and
                press Clock Punch In, then Clock Punch Out in the evening. The phone location is checked against the
                project&apos;s attendance radius.
              </li>
              <li>
                <strong>Biometric machine.</strong> Open <L to="/d/biometric">Biometric Devices</L>. In the Devices
                tab, register the machine&apos;s serial number against the project. In the Employee IDs tab, enter
                each employee&apos;s ID as enrolled on the machine. The screen shows the server address to type
                into the machine&apos;s Cloud Server Setting. Punches then arrive on their own.
              </li>
              <li>
                <strong>By hand.</strong> For a site without phones, open <L to="/d/payroll-attendance">Payroll</L>,
                go to the Attendance tab and mark Present, Absent, Half Day, Paid Leave or Week Off for each person.
              </li>
            </Steps>
            <p className="mt-2">Payroll reads this attendance at month end.</p>
          </>
        ),
        text: "attendance punch in punch out geofence biometric machine fingerprint face device essl zkteco employee id manual muster present absent",
        sources: ["frontend/src/app/c/[company_id]/d/attendance/page.tsx:1", "frontend/src/app/c/[company_id]/d/biometric/page.tsx:1"],
      },
      {
        q: "Step 11: What should the site team record every day?",
        a: (
          <>
            <Steps>
              <li>
                <strong>DPR.</strong> In <L to="/d/dpr">DPR (Daily Progress)</L> press + Create DPR. Choose the task,
                enter quantity done, workers on site, weather, material used, notes and any problem. One DPR per
                project per day.
              </li>
              <li>
                <strong>Quality.</strong> In <L to="/d/quality">Quality &amp; NCR</L> press + New Inspection, pick a
                checklist and mark each point Pass, Fail or NA. If something fails, raise an NCR in the NCR Tracker
                tab, then review and close it once fixed. Cube and other lab results go in the Lab Tests tab.
              </li>
              <li>
                <strong>Safety.</strong> In <L to="/d/safety">Safety</L> use + Report Incident for any near miss or
                injury, and log Toolbox Talks and PPE Compliance checks in their tabs.
              </li>
            </Steps>
          </>
        ),
        text: "daily dpr progress report create dpr workers quantity quality inspection checklist ncr close lab test cube safety incident toolbox talk ppe",
        sources: ["frontend/src/app/c/[company_id]/d/dpr/page.tsx:1", "frontend/src/app/c/[company_id]/d/quality/page.tsx:1"],
      },
      {
        q: "Step 12: How do I buy material, from request to bill?",
        a: (
          <>
            <p>
              Everything here is in <L to="/d/procurement">Procurement</L> with the project selected.
            </p>
            <Steps>
              <li>Site raises a request with + Material Indent. It is approved from the Indent tab or the Project Hub.</li>
              <li>
                To compare prices first, use Compare RFQs. Then press + Purchase Order, choose the vendor and
                items, and approve it.
              </li>
              <li>
                When the truck arrives, press Record GRN on that purchase order and enter the quantity actually
                received. Stock goes up.
              </li>
              <li>
                Enter the vendor&apos;s invoice in the project&apos;s Transaction tab as a Material Purchase. The
                Unbilled tab in Procurement lists goods received that have no invoice yet.
              </li>
              <li>
                Optional check: <L to="/d/three-way">Three-Way Match</L> compares the PO, the GRN and the invoice
                and flags any difference before you pay.
              </li>
              <li>Material used on site is recorded with Log Usage or on the DPR, and stock goes down.</li>
            </Steps>
          </>
        ),
        text: "buy material indent purchase order po rfq grn goods receipt record grn vendor invoice material purchase three way match stock log usage",
        sources: ["frontend/src/app/c/[company_id]/d/procurement/page.tsx:1080"],
      },
      {
        q: "Step 13: How do I give work to a subcontractor and pay their RA bills?",
        a: (
          <>
            <Steps>
              <li>
                In <L to="/d/subcon">Subcontractors</L> press + Sub Con Work Order. Choose the subcontractor and
                enter the items, quantities and rates.
              </li>
              <li>
                Each time they claim work done, go to <L to="/d/billing">Billing &amp; Invoices</L> and press +
                Submit RA Bill against that work order. Add TDS and retention as deductions. SiteFlow works out GST and
                shows the net payable.
              </li>
              <li>Approve the bill, then pay it as a Payment Out from the project&apos;s Transaction tab.</li>
            </Steps>
            <p className="mt-2">The Performance Scorecards tab rates each subcontractor on time, billing accuracy and quality.</p>
          </>
        ),
        text: "subcontractor work order ra bill running account bill retention tds net payable submit ra bill scorecard",
        sources: ["frontend/src/app/c/[company_id]/d/subcon/page.tsx:1", "frontend/src/app/c/[company_id]/d/billing/page.tsx:1"],
      },
      {
        q: "Step 14: How do I bill the client and record money in and out?",
        a: (
          <>
            <p>
              Open the project from <L to="/projects">Projects</L> and go to its Transaction tab.
            </p>
            <Steps>
              <li>
                Choose the type from the row along the top: Sales Invoice to bill the client, Payment In when the
                client pays, Payment Out when you pay someone, Material Purchase, Other Expense, Equipment Expense,
                Debit Note, Credit Note and so on.
              </li>
              <li>Press + Add Transaction. The form matches the type you picked.</li>
              <li>Pick the party, enter the lines and any deductions, and save.</li>
            </Steps>
            <p className="mt-2">
              Company-wide money, bank and cash accounts, and payment requests waiting for approval are in{" "}
              <L to="/d/finance">Finance</L>.
            </p>
          </>
        ),
        text: "bill client sales invoice payment in payment out receive money pay vendor transaction add transaction debit note credit note expense",
        sources: ["frontend/src/app/c/[company_id]/p/[project_id]/transaction/page.tsx:798"],
      },
      {
        q: "Step 15: What do I do at month end?",
        a: (
          <>
            <Steps>
              <li>
                <strong>Payroll.</strong> Open <L to="/d/payroll-attendance">Payroll</L> and press + New Payroll for
                the month. Salaries are worked out from attendance, with PF, ESI and TDS. Payslips can be exported.
              </li>
              <li>
                <strong>Statutory.</strong> In <L to="/d/statutory">Statutory</L>, generate the PF-ECR, GSTR-1 and
                TDS 26Q data for the month and keep a record of each filing with its acknowledgement number.
              </li>
              <li>
                <strong>Reports.</strong> <L to="/reports">Reports</L> has ready reports for sales, purchases,
                parties, retention, stock and more. <L to="/analytics">Analytics</L> shows progress and spending
                curves.
              </li>
            </Steps>
          </>
        ),
        text: "month end payroll run new payroll payslip pf esi tds statutory pf ecr gstr-1 26q reports analytics",
        sources: ["frontend/src/app/c/[company_id]/d/payroll-attendance/page.tsx:1059"],
      },
    ],
  };
}

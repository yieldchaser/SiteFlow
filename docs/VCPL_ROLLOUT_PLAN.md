# VCPL rollout plan

Live rollout of SiteFlow at Vidson Construction Pvt Ltd, starting 3 November 2026.

## Who

| Person | Role in SiteFlow (during implementation) |
|---|---|
| Prateek (founder) | Owner |
| Owner (Mama) | Admin, looks at progress daily |
| BBA assistant | Admin, enters the data |
| Construction guide (10-15 yrs site experience) | Admin, checks that the entries make site sense |
| Everyone else | Viewer |

Access is tightened once implementation is done.

## Company setup

- The demo company stays as it is, for demos. Rename it "SiteFlow Demo" so nobody enters real data there.
- Create a new company for the real books under the founder's login (company switcher, Create company).
- Every new company gets the 10 standard roles automatically.

## Module order (one module per working day or two)

| Week | Modules | Done when |
|---|---|---|
| 1 | Setup, HR: employees, weekly off, leave policy, holidays, daily attendance, leave apply/approve | Every employee is in, and attendance is marked daily |
| 1 | Equipment: machines, deploy/return with meter readings, fuel, maintenance | Every machine on site is in |
| 2 | DPR, then indent, PO, GRN, purchase bill, payment, material stock | One real PO has gone all the way to payment |
| 3 | Subcontractor work orders and RA bills, client BOQ and RA bills, receipts | One real RA bill each way |
| 4 | November payroll trial run, PF/ESI files | 3 payslips checked by hand before paying |

## Before the first real payroll (end of November)

- Professional tax is not built yet. It must be added before payroll is run.
- Report screens are not yet checked against the ledgers. Use P&L and party balances until then.

## Infrastructure

- The backend runs on Render's free plan, which sleeps when idle (first load about 50 seconds). Upgrade it before daily use.
- The Cloudflare move for the frontend can be done any time mid-rollout. Data is not touched. Avoid payroll week.

## Day 1 status (3 November 2026)

Debuted: sites and employees with daily attendance, and the equipment register.

- Sites: Projects > + Create Project (name and state required; steps 2 and 3 optional). Office staff go under a project named Head Office.
- Off days: Settings > Holiday & Weekoff (weekly off days, then named holidays). Company-wide for now.
- Employees: HR & Staff > + Add Staff. Pick the site, PF yes or no, cash or bank (account and IFSC). Entered by hand from an Excel the sites send.
- Attendance: HR & Staff > Attendance (register), or Attendance on the phone (check-in with location).
- Machines: Equipment (add, send to site with start meter, return with end meter, fuel, service).

To build before November payroll:
- Professional tax.
- Weekly off per employee and holidays per site.
- An office type of project, so Head Office does not show as a site; map picker for site location.
- Full view-permission enforcement before anyone gets a restricted role.

Not yet tried with real data: biometric machines, report screens, linking branches to projects.

## Demo feedback (9 November 2026)

From the VCPL executive during the demo:

1. Professional tax (heard as "PTI") was missing from payroll. Built: pick the company's state under Settings > Payroll, PT comes off each payslip by that state's slab, staff can be marked exempt on their record.
2. Adding an employee had no bank name. Built: a bank picker with the common Indian banks (SBI, HDFC, ICICI, Axis, Bank of Baroda and others), filled in from the IFSC when possible, with "Other bank" for anything else.
3. Company assets such as laptops had no home. Built: a Company Assets tab in Equipment with serial number and who holds each one.
4. More project categories. Built: piling, jetty and marine, ports, roads, bridges, metro, water, power, oil and gas, warehouse, and Head Office / Office.

Also fixed: a person moved to another site after that month's payroll ran was paid again by the new site's run.

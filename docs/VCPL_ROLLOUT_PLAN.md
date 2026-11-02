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

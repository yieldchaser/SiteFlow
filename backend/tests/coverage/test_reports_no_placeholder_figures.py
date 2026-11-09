"""Reports printed made-up figures: every task 100 units, every BOQ line 0
done, every work order 0 billed, payroll net = gross minus TDS only. These
check each report against figures worked out by hand from seeded records."""
import datetime
import uuid

from app import models
from app.routers.reports import _REPORT_HANDLERS

_TAG = uuid.uuid4().hex[:8]


def _setup(db, make_tenant):
    tag = uuid.uuid4().hex[:8]
    comp, _user, team = make_tenant(
        company_name=f"RPF-{tag}", user_name=f"RPF-{tag}",
        mobile="+917" + str(int(tag, 16))[-8:], email=f"rpf-{tag}@test.com",
    )
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower Site", code=f"TS-{_TAG}", status="Ongoing")
    db.add(p)
    db.flush()
    boq = models.BOQItem(id=uuid.uuid4(), project_id=p.id, section_name="RCC", item_name="M25 slab concrete",
                         unit="cum", quantity=200, rate=6000, amount=None, supply_tax_pct=18)
    db.add(boq)
    db.flush()
    day = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
    t = models.Task(id=uuid.uuid4(), project_id=p.id, name="Slab L5", duration_days=5, start_date=day,
                    end_date=day + datetime.timedelta(days=5), boq_item_id=boq.id, progress=40)
    db.add(t)
    db.flush()
    wo = models.WorkOrder(id=uuid.uuid4(), project_id=p.id, company_id=comp.id, subcontractor_id=team.id,
                          wo_number=f"WO-{_TAG}", wo_date=day, estimated_work_amount=500000, status="active")
    db.add(wo)
    db.flush()
    db.add(models.WorkOrderItem(id=uuid.uuid4(), wo_id=wo.id, task_id=t.id, quantity=100, rate=5000, amount=500000))
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                       wo_id=wo.id, invoice_number=f"RA-{_TAG}", invoice_date=day, invoice_type="subcon",
                       subtotal=150000, total_payable=150000))
    db.add(models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, name=f"Ravi {_TAG}", status="active",
        basic_salary=20000, hra=8000, other_allowances=2000,
        pf_employee_pct=12, pf_employer_pct=12, esi_employee_pct=0.75, esi_employer_pct=3.25,
        tds_monthly=0, is_esi_applicable=True, pt_applicable=False,
        date_of_joining=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)))
    db.commit()
    return comp, p


def test_boq_task_and_work_order_reports_use_recorded_progress(db, make_tenant):
    comp, p = _setup(db, make_tenant)

    boq_row = _REPORT_HANDLERS["boq-item"](db, comp.id, p.id)[0]
    assert float(boq_row["% Done"]) == 40.0
    assert float(boq_row["Done Quantity"]) == 80.0            # 200 x 40%
    assert float(boq_row["Amount w/o Tax"]) == 1200000.0      # 200 x 6000
    assert float(boq_row["Total Amount"]) == 1416000.0        # + 18%
    assert "Billed Qty" not in boq_row

    task_row = _REPORT_HANDLERS["task-boq-billed-unbilled"](db, comp.id, p.id)[0]
    assert float(task_row["Estimated Qty"]) == 200.0
    assert float(task_row["Done Qty"]) == 80.0
    assert float(task_row["Remaining Qty"]) == 120.0
    assert float(task_row["Work Done Value"]) == 480000.0

    wo_row = _REPORT_HANDLERS["boq-workorder-summary"](db, comp.id, p.id)[0]
    assert float(wo_row["Work Done Amount"]) == 200000.0      # 5,00,000 x 40%
    assert float(wo_row["Billed Amount"]) == 150000.0
    assert float(wo_row["Done but Not Billed"]) == 50000.0
    assert float(wo_row["Left to Bill on Order"]) == 350000.0
    assert float(wo_row["% Work Done"]) == 40.0


def test_payroll_library_net_and_ctc_include_pf_and_esi(db, make_tenant):
    comp, _p = _setup(db, make_tenant)
    row = _REPORT_HANDLERS["payroll-library"](db, comp.id, None)[0]
    assert "Shift Hours" not in row
    assert float(row["Gross Salary"]) == 30000.0
    # PF 12% of basic capped at 15,000 = 1,800. Gross 30,000 is above the
    # 21,000 ESI limit, so no ESI. Net = 30,000 - 1,800.
    assert float(row["Net Salary"]) == 28200.0
    assert float(row["Monthly CTC"]) == 31800.0               # + employer PF 1,800
    assert float(row["Yearly CTC"]) == 381600.0


def test_material_reports_follow_order_receipt_and_use(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    day = datetime.datetime(2026, 9, 2, tzinfo=datetime.timezone.utc)
    po = models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id,
                              po_number=f"PO-{uuid.uuid4().hex[:6]}", po_date=day, status="approved")
    db.add(po)
    db.flush()
    item = models.PurchaseOrderItem(id=uuid.uuid4(), po_id=po.id, material_name="Cement OPC 53",
                                    quantity=500, unit="bag", rate=400, tax_pct=28)
    db.add(item)
    grn = models.GoodsReceiptNote(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, po_id=po.id,
                                  grn_number=f"GRN-{uuid.uuid4().hex[:6]}", received_date=day)
    db.add(grn)
    db.flush()
    db.add(models.GRNItem(id=uuid.uuid4(), grn_id=grn.id, po_item_id=item.id, received_qty=300))
    db.add(models.MaterialTransaction(id=uuid.uuid4(), project_id=p.id, material_name="Cement OPC 53",
                                      qty=300, type="received", unit="bag"))
    db.add(models.MaterialTransaction(id=uuid.uuid4(), project_id=p.id, material_name="Cement OPC 53",
                                      qty=120, type="used", unit="bag"))
    task = db.query(models.Task).filter(models.Task.project_id == p.id).first()
    db.add(models.DailyProgressReport(id=uuid.uuid4(), project_id=p.id, task_id=task.id, reported_by="SE",
                                      dpr_date=day, executed_qty=10,
                                      materials_consumed=[{"material_name": "Cement OPC 53", "quantity": 45, "unit": "bag"}]))
    db.commit()

    qty = _REPORT_HANDLERS["budget-vs-actual-material-qty"](db, comp.id, p.id)[0]
    assert (float(qty["Ordered Qty"]), float(qty["Received Qty"]), float(qty["Still to Receive"])) == (500.0, 300.0, 200.0)
    assert (float(qty["Used Qty"]), float(qty["In Stock"])) == (120.0, 180.0)

    val = _REPORT_HANDLERS["budget-vs-actual-material-cost"](db, comp.id, p.id)[0]
    assert float(val["Avg Order Rate (INR)"]) == 400.0
    assert float(val["Used Value (INR)"]) == 48000.0
    assert float(val["Stock Value (INR)"]) == 72000.0

    tm = _REPORT_HANDLERS["task-material"](db, comp.id, p.id)[0]
    assert tm["Task Name"] == "Slab L5"
    assert float(tm["Qty Used"]) == 45.0
    assert float(tm["Cost (INR)"]) == 18000.0           # 45 bags x Rs 400, not Rs 100

    mb = _REPORT_HANDLERS["subcon-measurement-book"](db, comp.id, p.id)[0]
    assert float(mb["Order Qty"]) == 100.0
    assert float(mb["Done Qty"]) == 40.0                 # task 40% done, not the full order
    assert float(mb["Remaining Qty"]) == 60.0


def _sale_bill(db, comp, p, team, subtotal, gst, deds):
    day = datetime.datetime(2026, 9, 5, tzinfo=datetime.timezone.utc)
    total = subtotal + gst - sum(a for _t, a, _r in deds)
    b = models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                    invoice_number=f"INV-{uuid.uuid4().hex[:6]}", invoice_date=day, invoice_type="sale",
                    subtotal=subtotal, gst_amount=gst, total_payable=total, paid_amount=0)
    db.add(b)
    db.flush()
    for kind, amt, released in deds:
        db.add(models.TransactionDeduction(id=uuid.uuid4(), bill_id=b.id, deduction_type=kind,
                                           amount=amt, released_amount=released))
    return b


def test_sales_summary_shows_gross_retention_and_deductions(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    # Work 1,00,000 + GST 18,000 = 1,18,000. Retention 5,000 and TDS 2,000 held.
    _sale_bill(db, comp, p, team, 100000, 18000, [("Retention", 5000, None), ("TDS", 2000, None)])
    db.commit()
    row = _REPORT_HANDLERS["project-wise-sales-summary"](db, comp.id, p.id)[0]
    assert float(row["Total Sales"]) == 118000.0
    assert float(row["Retention Amount"]) == 5000.0
    assert float(row["Post Tax Deduction"]) == 2000.0
    assert float(row["Net Amount"]) == 111000.0


def test_party_balance_counts_notes_and_retention(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    _sale_bill(db, comp, p, team, 100000, 0, [("Retention", 5000, 1000)])
    # Approved credit note of 10,000 to the client; a pending one must not count.
    db.add(models.CreditNote(id=uuid.uuid4(), project_id=p.id, company_id=comp.id, party_company_user_id=team.id,
                             total_amount=10000, approval_flag="approved"))
    db.add(models.CreditNote(id=uuid.uuid4(), project_id=p.id, company_id=comp.id, party_company_user_id=team.id,
                             total_amount=7000, approval_flag="pending"))
    # Debit note of 20,000 against the subcon bill from _setup (1,50,000).
    db.add(models.DebitNote(id=uuid.uuid4(), project_id=p.id, company_id=comp.id, party_company_user_id=team.id,
                            total_amount=20000, approval_flag="auto_approved"))
    db.commit()
    row = _REPORT_HANDLERS["project-level-party-balance"](db, comp.id, p.id)[0]
    assert float(row["Credit Note"]) == 10000.0
    assert float(row["Debit Note"]) == 20000.0
    assert float(row["Retention Held"]) == 4000.0        # 5,000 held, 1,000 released
    assert "Salary" not in row and "Material Return" not in row
    # Client side: 95,000 - 10,000 = 85,000 owed to us.
    # Subcon side: 1,50,000 - 20,000 = 1,30,000 we owe. Net = -45,000.
    assert float(row["Net Balance"]) == 45000.0          # shown as an amount; type says the direction
    assert row["Balance Type"] == "To Pay"


def test_material_request_shows_ordered_and_pending(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    day = datetime.datetime(2026, 9, 3, tzinfo=datetime.timezone.utc)
    ind = models.MaterialIndent(id=uuid.uuid4(), company_id=comp.id, project_id=p.id,
                                indent_number=f"MR-{uuid.uuid4().hex[:6]}", status="approved")
    db.add(ind)
    db.flush()
    db.add(models.MaterialIndentItem(id=uuid.uuid4(), indent_id=ind.id, material_name="TMT Bar 12mm",
                                     quantity=10, unit="MT"))
    po_no = f"PO-{uuid.uuid4().hex[:6]}"
    for status, qty, num in (("approved", 6, po_no), ("cancelled", 4, f"PO-{uuid.uuid4().hex[:6]}")):
        po = models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, indent_id=ind.id,
                                  po_number=num, po_date=day, status=status)
        db.add(po)
        db.flush()
        db.add(models.PurchaseOrderItem(id=uuid.uuid4(), po_id=po.id, material_name="TMT Bar 12mm",
                                        quantity=qty, unit="MT", rate=60000))
    db.commit()
    row = _REPORT_HANDLERS["material-request-item"](db, comp.id, p.id)[0]
    assert float(row["Ordered Quantity"]) == 6.0
    assert float(row["Pending Quantity"]) == 4.0
    assert row["PO No."] == po_no


def test_company_expense_shows_deductions_and_plain_type(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    day = datetime.datetime(2026, 9, 6, tzinfo=datetime.timezone.utc)
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                       invoice_number=f"PB-{uuid.uuid4().hex[:6]}", invoice_date=day, invoice_type="purchase",
                       subtotal=50000, gst_amount=9000, total_payable=58000))   # 1,000 TDS held
    db.commit()
    rows = _REPORT_HANDLERS["company-expense"](db, comp.id, p.id)
    row = next(r for r in rows if r["Txn Type"] == "Material Purchase")
    assert float(row["Total Amount"]) == 59000.0
    assert float(row["Deductions"]) == 1000.0
    assert float(row["Net Amount"]) == 58000.0
    assert "Bill Discount" not in row


def test_equipment_used_counts_fuel_within_each_deployment(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    eq = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="JCB 3DX", code="MH12AB1234",
                          category="Excavator", ownership_type="owned", status="active")
    db.add(eq)
    db.flush()
    d1 = datetime.datetime(2026, 9, 1, 8, tzinfo=datetime.timezone.utc)
    d2 = datetime.datetime(2026, 9, 10, 8, tzinfo=datetime.timezone.utc)
    db.add(models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id, start_date=d1,
                                      end_date=d1, start_meter=1000, end_meter=1008))
    db.add(models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id, start_date=d2,
                                      end_date=d2, hours_used=5))
    db.add(models.FuelLog(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id, logged_date=d1, liters=40, cost_per_liter=90, total_cost=3600))
    db.add(models.FuelLog(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id, logged_date=d2, liters=25, cost_per_liter=90, total_cost=2250))
    db.commit()
    rows = _REPORT_HANDLERS["daily-based-equipment-used"](db, comp.id, p.id)
    by_hours = {float(r["Hours Used"]): r for r in rows}
    assert float(by_hours[8.0]["Fuel Added (Litres)"]) == 40.0   # not 65 on every row
    assert float(by_hours[5.0]["Fuel Added (Litres)"]) == 25.0
    assert "Total Trips" not in rows[0]


def test_warehouse_reports_value_stock_at_order_rate(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    day = datetime.datetime(2026, 9, 2, tzinfo=datetime.timezone.utc)
    po = models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id,
                              po_number=f"PO-{uuid.uuid4().hex[:6]}", po_date=day, status="approved")
    db.add(po)
    db.flush()
    db.add(models.PurchaseOrderItem(id=uuid.uuid4(), po_id=po.id, material_name="Sand", quantity=100,
                                    unit="cum", rate=1500))
    db.add(models.WarehouseInventory(id=uuid.uuid4(), project_id=p.id, material_name="Sand", unit="cum",
                                     on_hand_qty=55))
    for i, (kind, qty) in enumerate((("received", 80), ("used", 20), ("adjustment", -5))):
        db.add(models.MaterialTransaction(id=uuid.uuid4(), project_id=p.id, material_name="Sand", qty=qty,
                                          type=kind, unit="cum", created_at=day + datetime.timedelta(hours=i)))
    db.commit()
    cur = _REPORT_HANDLERS["warehouse-current-stock"](db, comp.id, p.id)[0]
    assert (float(cur["Total In Quantity"]), float(cur["Total Out Quantity"])) == (80.0, 25.0)
    assert float(cur["Avg Purchase Price"]) == 1500.0
    assert float(cur["Current Stock Value"]) == 82500.0      # 55 x 1,500
    mv = _REPORT_HANDLERS["warehouse-stock-movement"](db, comp.id, p.id)
    assert [float(r["Closing Qty"]) for r in mv] == [80.0, 60.0, 55.0]
    assert [float(r["Opening Qty"]) for r in mv] == [0.0, 80.0, 60.0]
    assert float(mv[-1]["Stock Value"]) == 82500.0
    tx = _REPORT_HANDLERS["warehouse-transaction"](db, comp.id, p.id)
    used = next(r for r in tx if r["Transaction Type"] == "Used")
    assert float(used["Value"]) == 30000.0                   # 20 x 1,500


def test_equipment_still_on_site_counts_fuel_to_date(db, make_tenant):
    comp, p = _setup(db, make_tenant)
    eq = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="DG Set", code="DG-01",
                          category="Power", ownership_type="owned", status="active")
    db.add(eq)
    db.flush()
    now = datetime.datetime.now(datetime.timezone.utc)
    db.add(models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id,
                                      start_date=now - datetime.timedelta(days=10), end_date=None))
    db.add(models.FuelLog(id=uuid.uuid4(), equipment_id=eq.id, project_id=p.id,
                          logged_date=now - datetime.timedelta(days=3), liters=60, cost_per_liter=90, total_cost=5400))
    db.commit()
    row = _REPORT_HANDLERS["daily-based-equipment-used"](db, comp.id, p.id)[0]
    assert float(row["Fuel Added (Litres)"]) == 60.0

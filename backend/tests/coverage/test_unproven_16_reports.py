import uuid
import datetime
from decimal import Decimal
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import (
    Base, Company, Project, User, CompanyTeam, Bill, Payment,
    DailyProgressReport, Task, PurchaseOrder, PurchaseOrderItem,
    WarehouseInventory, StaffEmployee, AttendanceLog, CRMLead,
    CRMQuotation, CRMQuotationItem, MaterialTransaction, GRNItem,
    GoodsReceiptNote, BankAccount, TransactionDeduction, PaymentRequest,
    BOQItem, BOQDocument, LibraryCostCode, LibraryRate, MaterialIndent,
    MaterialIndentItem, Todo
)
from app.routers.reports import _REPORT_HANDLERS

# Exact metadata columns matching frontend REPORT_METADATA for all 16 unproven reports
EXPECTED_COLUMNS = {
    "boq-item": ['Project Name', 'BOQ Name', 'Client Name', 'BOQ Date', 'Section', 'Item Name', 'Unit', 'Quantity', '% Done', 'Done Quantity', 'Unit Rate', 'Amount w/o Tax', 'GST %', 'Total Amount', 'Cost Code'],
    "boq-measurement-book": ['Project Name', 'Section', 'Item Name', 'Task Name', 'Progress Date', 'Unit', 'Estimated Quantity', 'Opening Quantity', 'Progress Quantity', 'Closing Quantity', 'Progress Notes'],
    "budget-vs-actual-cost-code": ['Cost Code', 'Budget Amount (INR)', 'Actual Amount (INR)', 'Difference (INR)', 'Status'],
    "budget-vs-actual-material-cost": ['Project', 'Material', 'Unit', 'Avg Order Rate (INR)', 'Ordered Value (INR)', 'Received Value (INR)', 'Used Value (INR)', 'Stock Value (INR)'],
    "budget-vs-actual-material-qty": ['Project', 'Material', 'Unit', 'Ordered Qty', 'Received Qty', 'Still to Receive', 'Used Qty', 'In Stock'],
    "cost-code-library": ['Cost Code', 'Sub Cost Code', 'Created Date', 'Description'],
    "item-wise-sales": ['Client Name', 'Invoice Date', 'Item Name', 'Unit', 'Quantity', 'Item Rate', 'Tax %', 'Total Amount', 'Invoice Created'],
    "material-received-without-po": ['Project Name', 'Party Name', 'Created By', 'Receiving Date', 'Unit', 'Quantity'],
    "material-request-item": ['Request Date', 'Request No.', 'Project Name', 'Material Name', 'Specifications', 'Unit', 'Request Quantity', 'Ordered Quantity', 'Pending Quantity', 'PO No.', 'Requested by', 'Status', 'Approved/Rejected By', 'Request Notes'],
    "payment-request": ['Payment Request ID', 'Payment Request No.', 'Project Name', 'Party Name', 'Amount', 'Payment Date', 'Due Date', 'Creator Name', 'Request Type', 'Approval Status', 'Payment Status', 'Remark'],
    "quotation": ['Quotation Name', 'Quotation Number', 'Client Name', 'Quotation Date', 'Item Count', 'Item Sub Total', 'Discount', 'Additional Charges', 'Tax', 'Total Amount', 'Quotation Status', 'Created Date'],
    "quotation-item": ['Client Name', 'Quotation Name', 'Quotation Status', 'Quotation Date', 'Group', 'Section', 'Item Name', 'Unit', 'Estimated Qty', 'Unit Cost Price', 'Markup', 'Sales Unit Price', 'Total Sales Amount', 'Tax %', 'Total with Tax'],
    "rate-card-library": ['Description', 'Item Code', 'Cost Code', 'Unit', 'Components', 'Unit Cost Price', 'Markup Amount', 'Markup %', 'Selling Price', 'Created Date', 'Component Count', 'HSN/SAC'],
    "subcon-material-issue": ['Project Name', 'Subcon Name', 'Material Name', 'Avg Unit Price (INR)', 'Total Quantity Issued', 'Total Cost (INR)'],
    "todo-report": ['Activity Name', 'Project Name', 'Status', 'Creation Date', 'Due Date', 'Last Updated Date', 'Assigned To', 'Type', 'Related Task', 'Creator Name', 'Closed Date'],
}


@pytest.fixture(scope="module")
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()


def test_16_unproven_reports_with_seeded_data(db_session):
    cid = uuid.uuid4()
    company = Company(id=cid, name="Test Construction Ltd")
    db_session.add(company)

    pid = uuid.uuid4()
    project = Project(id=pid, company_id=cid, name="Skyline Tower", status="Active", project_value=Decimal("50000000.0"))
    db_session.add(project)

    uid = uuid.uuid4()
    user = User(id=uid, email=f"lead_{uid.hex[:6]}@example.com", name="John Architect")
    db_session.add(user)

    ct = CompanyTeam(id=uuid.uuid4(), company_id=cid, user_id=uid, priority_type="Admin")
    db_session.add(ct)

    # 1. BOQDocument & BOQItem
    boq_doc = BOQDocument(
        id=uuid.uuid4(),
        project_id=pid,
        title="Main Tower Civil BOQ",
    )
    db_session.add(boq_doc)

    boq = BOQItem(
        id=uuid.uuid4(),
        project_id=pid,
        boq_document_id=boq_doc.id,
        section_name="Substructure",
        item_name="Structural Steel Reinforcement",
        unit="MT",
        quantity=Decimal("120.5"),
        rate=Decimal("65000.0"),
        amount=Decimal("7832500.0"),
        cost_code="CC-STR-01",
    )
    db_session.add(boq)

    # A task on that BOQ line with one day's progress, for the measurement book.
    mb_task = Task(
        id=uuid.uuid4(), project_id=pid, name="Rebar tying - raft", duration_days=10,
        start_date=datetime.datetime(2026, 7, 1), end_date=datetime.datetime(2026, 7, 10),
        boq_item_id=boq.id, progress=Decimal("25.0"),
    )
    db_session.add(mb_task)
    db_session.add(DailyProgressReport(
        id=uuid.uuid4(), project_id=pid, task_id=mb_task.id, reported_by="Site Engineer",
        dpr_date=datetime.datetime(2026, 7, 2), executed_qty=Decimal("30.0"),
    ))

    # 2. LibraryCostCode
    cc = LibraryCostCode(
        id=uuid.uuid4(),
        company_id=cid,
        code="CC-STR-01",
        sub_cost_code="SUB-01",
        name="Structural Steel",
        budget_amount=Decimal("8000000.0"),
    )
    db_session.add(cc)

    # 3. Bill
    bill = Bill(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        party_company_user_id=ct.id,
        invoice_number="INV-2026-001",
        invoice_type="client",
        status="Approved",
        subtotal=Decimal("1500000.0"),
        total_payable=Decimal("1500000.0"),
        paid_amount=Decimal("1000000.0"),
        invoice_date=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(bill)

    # 4. PurchaseOrder & GRN
    po = PurchaseOrder(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        po_number="PO-2026-001",
        po_date=datetime.datetime.now(datetime.timezone.utc),
        vendor_id=ct.id,
    )
    db_session.add(po)

    po_item = PurchaseOrderItem(
        id=uuid.uuid4(),
        po_id=po.id,
        material_name="TMT Rebars Fe500D",
        quantity=Decimal("100.0"),
        rate=Decimal("62000.0"),
        unit="MT",
    )
    db_session.add(po_item)

    grn = GoodsReceiptNote(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        po_id=None,
        grn_number="GRN-DIRECT-001",
        received_date=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(grn)

    grn_item = GRNItem(
        id=uuid.uuid4(),
        grn_id=grn.id,
        po_item_id=po_item.id,
        received_qty=Decimal("25.0"),
    )
    db_session.add(grn_item)

    # 5. MaterialIndent & Item
    mr = MaterialIndent(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        indent_number="MR-2026-042",
        status="pending",
    )
    db_session.add(mr)

    mr_item = MaterialIndentItem(
        id=uuid.uuid4(),
        indent_id=mr.id,
        material_name="OPC 53 Cement",
        quantity=Decimal("500.0"),
        unit="Bags"
    )
    db_session.add(mr_item)

    # 6. PaymentRequest
    pr = PaymentRequest(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        party_company_user_id=ct.id,
        party_name="Supreme Steel Corp",
        amount=450000.0,
        status="Pending",
        due_date=datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=5),
    )
    db_session.add(pr)

    # 7. CRMQuotation & Item
    lead = CRMLead(
        id=uuid.uuid4(),
        company_id=cid,
        lead_name="Apex Heights Corp",
        lead_type="client",
        contact_name="Vikram Mehta",
        phone_no="9876543210",
        client_company_name="Apex Real Estate",
        status="Proposal Stage",
    )
    db_session.add(lead)

    quote = CRMQuotation(
        id=uuid.uuid4(),
        lead_id=lead.id,
        subject="Piling & Civil Scope Quotation",
        qt_no="QT-2026-088",
        total_amount=Decimal("12500000.0"),
        status="Sent",
    )
    db_session.add(quote)

    q_item = CRMQuotationItem(
        id=uuid.uuid4(),
        quotation_id=quote.id,
        section_name="Civil Works",
        item_name="Piling & Foundation Works",
        unit="LS",
        qty=Decimal("1.0"),
        selling_price=Decimal("12500000.0"),
        cost_price=Decimal("10000000.0"),
        total_amount=Decimal("12500000.0"),
    )
    db_session.add(q_item)

    # Link quotation to bill for item-wise sales
    bill.quotation_id = quote.id

    # 8. LibraryRate
    rate_card = LibraryRate(
        id=uuid.uuid4(),
        company_id=cid,
        name="RCC M25 Grade Concrete",
        item_code="RC-CONC-M25",
        cost_code="CC-STR-01",
        unit="cum",
        unit_cost=Decimal("4800.0"),
        markup_value=Decimal("15.0"),
        markup_type="percent",
        unit_sale_price=Decimal("5520.0"),
    )
    db_session.add(rate_card)

    # 9. MaterialTransaction (subcon issue)
    mt = MaterialTransaction(
        id=uuid.uuid4(),
        project_id=pid,
        type="issue",
        material_name="TMT 16mm Rebar",
        qty=Decimal("15.0"),
        unit="MT",
    )
    db_session.add(mt)

    # 10. Todo
    todo = Todo(
        id=uuid.uuid4(),
        company_id=cid,
        project_id=pid,
        title="Inspection of 5th Floor Slab Pouring",
        status="Pending",
        due_date=datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=2),
    )
    db_session.add(todo)

    db_session.commit()

    results = []
    print("\n--- 16 UNPROVEN REPORTS VERIFICATION TABLE ---")
    print(f"{'SLUG':<35} | {'ROWS':<5} | {'KEY MATCH':<10}")
    print("-" * 55)
    for slug, expected_cols in EXPECTED_COLUMNS.items():
        assert slug in _REPORT_HANDLERS, f"Missing handler for {slug}"
        handler = _REPORT_HANDLERS[slug]
        rows = handler(db_session, cid, pid)
        assert isinstance(rows, list), f"{slug} returned non-list: {type(rows)}"
        assert len(rows) > 0, f"{slug} returned 0 rows despite seeded data!"

        first_row = rows[0]
        row_keys = set(first_row.keys())
        expected_set = set(expected_cols)

        missing_keys = expected_set - row_keys
        extra_keys = row_keys - expected_set
        match = (row_keys == expected_set)

        print(f"{slug:<35} | {len(rows):<5} | {'YES' if match else 'NO'}")
        if not match:
            print(f"  -> Missing: {missing_keys}")
            print(f"  -> Extra: {extra_keys}")
        results.append({
            "slug": slug,
            "rows": len(rows),
            "key_match": match,
            "missing": list(missing_keys),
            "extra": list(extra_keys)
        })

    for res in results:
        assert res["key_match"] is True, f"Key mismatch for {res['slug']}: missing {res['missing']}, extra {res['extra']}"

if __name__ == "__main__":
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=eng)
    S = sessionmaker(autocommit=False, autoflush=False, bind=eng)
    s = S()
    test_16_unproven_reports_with_seeded_data(s)

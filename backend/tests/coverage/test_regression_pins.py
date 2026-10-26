from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = Path(__file__).resolve().parents[3] / "frontend"


def _read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def _read_frontend(rel):
    return (FRONTEND_ROOT / rel).read_text(encoding="utf-8")


def test_pin_R2_096_party_balance_nets_correctly():
    src = _read("app/routers/finance.py")
    assert "advance_paid + to_receive - advance_received - to_pay" in src, "R2-096 balance formula regressed"
    assert 'status = "To Receive"' in src, "R2-096 net-sign status derivation regressed"


def test_pin_R2_054_pr_number_collision_loop():
    src = _read("app/routers/finance.py")
    assert "PaymentRequest.request_no == candidate" in src, "R2-054 PR collision loop regressed"


def test_pin_R2_098_pid_collision_loop():
    src = _read("app/routers/library.py")
    assert "LibraryParty.party_id_custom == candidate" in src, "R2-098 PID collision loop regressed"


def test_pin_R2_035_project_progress_reads_task_progress():
    src = _read("app/routers/projects.py")
    assert "float(t.progress or 0.0) / 100.0" in src, "R2-035 task-progress read regressed"


def test_pin_R2_036_spend_filters_expense_types():
    analytics = _read("app/routers/analytics.py")
    budget = _read("app/routers/budget.py")
    towers = _read("app/routers/towers.py")
    scope = _read("app/bill_scope.py")
    assert analytics.count("Bill.invoice_type.in_(EXPENSE_INVOICE_TYPES)") >= 1, "R2-036 operational spend filter regressed"
    # R2-036: the per-bill filters moved from the `in EXPENSE_INVOICE_TYPES` form to the
    # shared is_expense_invoice_type() helper (D3/bill_scope). Pin the helper's call count,
    # not a bare substring - a substring check passes on the import line alone.
    assert analytics.count("is_expense_invoice_type(") >= 3, "R2-036 project/month spend filters regressed"
    assert towers.count("_active_bills(db, project_id, REVENUE_INVOICE_TYPES)") >= 2, "R2-036 towers billed filters regressed"
    # R2-723: the expense-type + cancelled filters moved into bill_scope._active_bills.
    assert "Bill.invoice_type.in_(invoice_types)" in scope, "R2-036 shared invoice-type scope filter regressed"
    assert 'Bill.status != "Cancelled"' in scope, "R2-036 cancelled-bill exclusion regressed"
    assert budget.count("_active_bills(") >= 2, "R2-036 budget actual filters regressed"


def test_pin_R2_037_wastage_suppressed_without_consumption():
    src = _read("app/routers/analytics.py")
    assert "has_consumption" in src, "R2-037 wastage suppression regressed"


def test_pin_R2_067_labour_and_equipment_actuals():
    src = _read("app/routers/budget.py")
    assert "PayrollLineItem.net_payable" in src, "R2-067 labour actual regressed"
    assert 'b.invoice_type == "equipment"' in src, "R2-067 equipment actual regressed"
    # R2-233: only approved bills book as actual spend.
    assert 'Bill.approval_flag == "approved",' in src, "R2-067 approved-only actuals gate regressed"


def test_pin_R2_029_zoho_duplicate_search_all_contact_types():
    src = _read("app/routers/zoho_books.py")
    assert 'contact_type: Optional[str] = "vendor"' in src, "R2-029 keyword param regressed"
    assert "contact_type=None" in src, "R2-029 unfiltered duplicate search regressed"


def test_pin_R2_106_location_verified_derived_from_geofence():
    src = _read("app/routers/hr.py")
    assert src.count("location_verified=within_geofence") >= 1, "R2-106 punch-in verification regressed"
    assert "log.location_verified = within_geofence" in src, "R2-106 punch-out verification regressed"


def test_pin_R2_031_task_status_derives_from_progress():
    src = _read("app/routers/planning.py")
    assert 'task.status = "ongoing"' in src, "R2-031 ongoing derivation regressed"
    assert 'task.status = "in_progress"' not in src, "R2-031 non-canonical in_progress reintroduced"


def test_pin_R2_044_billing_bucket_gates():
    src = _read("app/routers/billing.py")
    # R2-044: same helper migration as R2-036 above. Count the classifier calls rather than
    # accepting a single import-line match.
    assert src.count("is_revenue_invoice_type") >= 2, "R2-044 revenue bucket gate regressed"
    assert src.count("is_expense_invoice_type") >= 2, "R2-044 expense bucket gate regressed"


def test_pin_R2_011_party_type_allowlist_covers_ui_vocabulary():
    src = _read("app/routers/library.py")
    assert "Investor" in src, "R2-011 Investor party_type regressed"
    assert "Labour Contractor" in src, "R2-011 Labour Contractor party_type regressed"
    assert "Other Vendor" in src, "R2-011 Other Vendor party_type regressed"


def test_pin_R2_003_delete_logs_entity_types():
    src = _read_frontend("src/app/c/[company_id]/d/delete-logs/page.tsx")
    assert '"crm_lead",' in src, "R2-003 crm_lead entity type regressed"
    assert '"workorder",' not in src, "R2-003 dead workorder option reintroduced"


def test_pin_R2_060_no_fabricated_coordinates():
    d = _read_frontend("src/app/c/[company_id]/d/attendance/page.tsx")
    p = _read_frontend("src/app/c/[company_id]/p/[project_id]/attendance/page.tsx")
    for src in (d, p):
        assert "Location unavailable. Punch not recorded" in src, "R2-060 location guard regressed"
        assert "12.9716" not in src, "R2-060 fabricated Bangalore coords reintroduced"
        assert "Metro Geofence Yard" not in src, "R2-060 fabricated geofence label reintroduced"


def test_pin_R2_068_009_no_stock_photos_anywhere():
    hits = [
        str(p)
        for p in FRONTEND_ROOT.rglob("*.tsx")
        if "unsplash" in p.read_text(encoding="utf-8", errors="ignore").lower()
    ]
    assert not hits, f"R2-068/009 unsplash fabrication reintroduced in: {hits}"


def test_pin_R2_040_report_export_never_xlsx():
    src = _read_frontend("src/app/c/[company_id]/reports/[slug]/page.tsx")
    assert ".xlsx" not in src, "R2-040 fake xlsx extension reintroduced"


def test_pin_R2_148_todo_mutations_persist():
    # Both to-do pages render the shared TodoBoard since 2026-10-27.
    for page in ("src/app/c/[company_id]/d/todo/page.tsx", "src/app/c/[company_id]/p/[project_id]/todo/page.tsx"):
        assert "TodoBoard" in _read_frontend(page), f"{page} no longer uses TodoBoard"
    src = _read_frontend("src/components/TodoBoard.tsx")
    assert src.count("apis/v3/todos/${") >= 2, "R2-148 todo PUT/DELETE wiring regressed"


def test_pin_R2_149_repeat_settings_removed():
    # R2-149 removed a decorative repeat modal that sent nothing. Recurrence
    # has a runtime since R2-383, so the repeat choice must now be SENT.
    src = _read_frontend("src/components/TodoBoard.tsx")
    assert "isRepeatModalOpen" not in src, "R2-149 repeat modal state reintroduced"
    assert "repeat_type: form.repeat_type" in src, "repeat choice shown but not sent (R2-149 shape)"


def test_pin_R2_032_ctc_no_double_count():
    src = _read_frontend("src/app/c/[company_id]/d/hr/page.tsx")
    assert "e.basic * 0.24" not in src, "R2-032 PF double-count formula reintroduced"


def test_pin_R2_168_no_frozen_dates():
    src = _read_frontend("src/app/c/[company_id]/d/hr/page.tsx")
    assert 'useState("2026' not in src, "R2-168 frozen date seed reintroduced"


def test_pin_R2_084_dashboard_status_normalization():
    src = _read_frontend("src/app/c/[company_id]/dashboard/page.tsx")
    assert 'p.status === "On Hold" || p.status === "Onhold"' in src, "R2-084 status normalization regressed"


def test_pin_R2_014_flush_queue_honest_counts():
    d = _read_frontend("src/app/c/[company_id]/d/attendance/page.tsx")
    p = _read_frontend("src/app/c/[company_id]/p/[project_id]/attendance/page.tsx")
    for src in (d, p):
        assert "failed and remain queued" in src, "R2-014 honest flush message regressed"


def test_pin_R2_107_dates_default_to_today():
    src = _read_frontend("src/app/c/[company_id]/d/attendance/page.tsx")
    # The default must be the LOCAL calendar day. toISOString() is UTC, so from
    # midnight until 05:30 IST it returns yesterday; this pin must reject that
    # form outright rather than tolerate it as an alternative.
    assert 'useState(todayLocalISO())' in src, "R2-107 today default regressed"
    assert 'new Date().toISOString().split("T")[0]' not in src, "R2-107 UTC date default reintroduced"


def test_pin_R2_107_no_frozen_dates_in_project_attendance():
    src = _read_frontend("src/app/c/[company_id]/p/[project_id]/attendance/page.tsx")
    assert 'useState("2026' not in src, "R2-107 frozen date seed reintroduced in project attendance"


def test_pin_R2_013_details_drawer_controlled():
    src = _read_frontend("src/app/c/[company_id]/d/hr/page.tsx")
    assert "defaultValue" not in src, "R2-013 uncontrolled drawer input reintroduced"


def test_pin_R2_015_quick_add_posts_real_todo():
    src = _read_frontend("src/app/c/[company_id]/d/home/page.tsx")
    assert src.count("/apis/v3/todos/") >= 2, "R2-015 quick-add POST wiring regressed"


def test_pin_R2_062_083_dashboard_no_fabricated_identity():
    src = _read_frontend("src/app/c/[company_id]/dashboard/page.tsx")
    assert "Acme Corp" not in src, "R2-062/083 fabricated customer name reintroduced"
    assert "Siddharth Malhotra" not in src, "R2-062/083 fabricated key person reintroduced"
    assert "fallbackMaterials" not in src, "R2-062 fabricated materials fallback reintroduced"


def test_pin_R2_027_face_log_has_created_at():
    src = _read("app/models.py")
    assert "created_at = Column(DateTime(timezone=True), default=func.now(), nullable=True)" in src, "R2-027 FaceRecognitionLog created_at regressed"


def test_pin_R2_086_face_page_surfaces_errors():
    src = _read_frontend("src/app/c/[company_id]/d/face-recognition/page.tsx")
    assert "setLoadError" in src, "R2-086 face page error state regressed"


def test_pin_R2_002_no_emoji_in_sidebar():
    sidebar = _read_frontend("src/components/Sidebar.tsx")
    reports = _read_frontend("src/app/c/[company_id]/reports/[slug]/page.tsx")
    for glyph in ("\U0001F4DD", "\u2705", "\U0001F4AC", "\u2B06"):
        assert glyph not in sidebar, f"R2-002 emoji {hex(ord(glyph))} reintroduced in Sidebar"
        assert glyph not in reports, f"R2-002 emoji {hex(ord(glyph))} reintroduced in reports page"


def test_pin_R2_079_no_demo_company_fallback():
    header = _read_frontend("src/components/PageHeader.tsx")
    reports = _read_frontend("src/app/c/[company_id]/reports/page.tsx")
    assert "demo-construction" not in header, "R2-079 demo company fallback reintroduced in PageHeader"
    assert "demo-construction" not in reports, "R2-079 demo company fallback reintroduced in reports dashboard"


def test_pin_R2_104_tally_summary_derived_from_logs():
    src = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert "setTallyLastMarked(new Date(Math.max(...markedTimes))" in src, "R2-104 tally summary derivation regressed"


def test_pin_R2_001_material_card_opens_drawer():
    src = _read_frontend("src/app/c/[company_id]/d/home/page.tsx")
    assert "setIsMaterialDrawerOpen(true)" in src, "R2-001 material card drawer affordance regressed"


def test_pin_R2_057_gantt_link_errors_use_server_detail():
    src = _read_frontend("src/app/c/[company_id]/d/planning/gantt/page.tsx")
    assert 'detail.toLowerCase().includes("circular")' in src, "R2-057 gantt link error detail regressed"


def test_pin_R2_070_no_local_only_indent_photo_input():
    src = _read_frontend("src/app/c/[company_id]/d/procurement/page.tsx")
    assert "setPreviewUrl(URL.createObjectURL(file))" not in src, "R2-070 local-only indent photo picker reintroduced"


def test_pin_R2_120_tally_card_and_tab_name():
    src = _read_frontend("src/app/c/[company_id]/settings/page.tsx")
    assert "tally/connections?company_id=" in src, "R2-120 Tally status fetch regressed"
    assert "Payroll Runs tab (HR)" in src, "R2-120 wrong tab name reintroduced"


def test_pin_R2_085_no_internal_phase_labels():
    import re
    src = _read_frontend("src/app/c/[company_id]/analytics/page.tsx")
    assert not re.search(r"PHASE 1[0-9]", src), "R2-085 internal phase label reintroduced on analytics"


def test_pin_R2_045_066_purchase_expense_and_equipment_bills():
    # R2-289: bi_export partitions the shared EXPENSE_INVOICE_TYPES scope
    # head-for-head like budget.py; R2-045/066 intent lives on in those buckets.
    src = _read("app/routers/bi_export.py")
    scope = _read("app/bill_scope.py")
    assert "_active_bills(db, p.id, EXPENSE_INVOICE_TYPES)" in src, "R2-045/066 expense bills no longer read through the cancelled-excluding _active_bills scope"
    assert 'if b.invoice_type == "purchase":' in src, "R2-045 purchase -> material bucket regressed"
    assert "material_actual += amount" in src, "R2-045 purchase material bucket regressed"
    assert 'elif b.invoice_type == "subcon":' in src, "R2-045 subcon bucket regressed"
    assert "subcon_actual += amount" in src, "R2-045 subcon bucket regressed"
    assert 'elif b.invoice_type == "equipment":' in src, "R2-066 equipment bucket regressed"
    assert "equipment_bill_total += amount" in src, "R2-066 equipment bucket regressed"
    assert "other_actual += amount" in src, "R2-045 expense catch-all bucket regressed"
    assert "Bill.invoice_type.in_(invoice_types)" in scope, "R2-045/066 bill_scope invoice-type semantics regressed"


def test_pin_R2_193_bi_api_key_inactivity_window():
    src = _read("app/routers/bi_export.py")
    assert "total_seconds() > 300" in src, "R2-193 BI API key 5-minute inactivity window regressed"


def test_pin_R2_251_mom_creator_from_session_user():
    src = _read("app/routers/mom.py")
    assert "created_by=current_user.name," in src, "R2-251 MOM created_by no longer derived from session user"


def test_pin_R2_071_wo_terms_uses_inner_text():
    src = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert "currentTarget.innerText" in src, "R2-071 WO terms innerText capture regressed"
    assert "currentTarget.innerHTML" not in src, "R2-071 WO terms innerHTML capture reintroduced"


def test_pin_R2_072_unbilled_materials_toggle():
    src = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert "setShowUnbilledOnly(!showUnbilledOnly)" in src, "R2-072 Unbilled Materials toolbar toggle regressed"


def test_pin_R2_428_csv_template_has_payment_type_no_sample():
    src = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert 'const tpl = "Payment Type' in src, "R2-428 CSV template string regressed"
    tpl_line = next(line for line in src.splitlines() if 'const tpl = "Payment Type' in line)
    assert "Sample" not in tpl_line, "R2-428 CSV template sample filler reintroduced"


def test_pin_R2_298_rfq_compare_metrics():
    src = _read("app/routers/rfq.py")
    assert "is_lowest" in src, "R2-298 RFQ is_lowest metric regressed"
    assert "price_spread" in src, "R2-298 RFQ price_spread metric regressed"
    assert "recommended_vendor_name" in src, "R2-298 RFQ recommended_vendor_name metric regressed"


def test_pin_R2_336_movements_do_not_reclassify_master_category():
    src = _read("app/routers/procurement.py")
    tx_body = src.split("def create_transaction", 1)[1].split("def ", 1)[0]
    assert "inv.category = req.category" not in tx_body, "R2-336 material movement reclassifies inventory master category"


def test_pin_R2_341_po_item_pending_qty_report():
    src = _read("app/routers/reports.py")
    assert '"PO Pending Qty"' in src, "R2-341 PO-item pending qty report regressed"


def test_pin_R2_351_grn_transaction_keeps_po_item_unit():
    src = _read("app/routers/procurement.py")
    assert "unit=po_item.unit" in src, "R2-351 GRN transaction unit derivation regressed"


def test_pin_R2_572_po_requires_at_least_one_item():
    src = _read("app/routers/procurement.py")
    assert "items: List[POCreateItemSchema] = Field(..., min_length=1)" in src, "R2-572 PO min-length items validation regressed"


def test_pin_R2_573_grn_rejects_future_received_date():
    src = _read("app/routers/procurement.py")
    assert "def received_date_not_future(cls, v: datetime) -> datetime:" in src, "R2-573 GRN future received_date validator regressed"
    assert 'raise ValueError("received_date cannot be in the future")' in src, "R2-573 GRN future-date rejection regressed"


def test_pin_R2_136_milestone_type_discriminator_pattern():
    src = _read("app/routers/planning.py")
    assert "pattern=MILESTONE_TYPE_PATTERN" in src, "R2-136 milestone type discriminator pattern regressed"
    assert "pattern=PREDECESSOR_LINK_TYPE_PATTERN" in src, "R2-136 predecessor link type discriminator pattern regressed"


def test_pin_R2_255_task_duration_non_negative():
    src = _read("app/routers/planning.py")
    assert "duration_days: int = Field(..., ge=0)" in src, "R2-255 task duration negative guard regressed"


def test_pin_R2_277_drawing_pin_bounds_and_creator():
    src = _read("app/routers/drawings.py")
    assert src.count("le=9999.99") >= 2, "R2-277 drawing pin coordinate bounds regressed"
    assert "created_by=membership.id" in src, "R2-277 drawing pin creator derivation regressed"


def test_pin_R2_373_indent_approval_guards_and_reject():
    src = _read("app/routers/procurement.py")
    assert 'if indent.status != "pending":' in src, "R2-373 indent approve pending-only guard regressed"
    assert "/indents/{indent_id}/reject" in src, "R2-373 indent reject endpoint regressed"
    models = _read("app/models.py")
    assert 'approved_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)' in models, "R2-373 indent approved_by FK regressed"


def test_pin_R2_378_no_dead_transaction_retention_model():
    src = _read("app/models.py")
    assert "class TransactionRetention" not in src, "R2-378 dead TransactionRetention model reintroduced"
    assert "transaction_retentions" not in src, "R2-378 dead transaction_retentions table reintroduced"


def test_pin_R2_411_tally_alter_ledger_with_reference():
    src = _read("app/tally_xml.py")
    assert 'ACTION="Alter"' in src, "R2-411 Tally Alter ledger action regressed"
    assert "<ALTERID>" in src, "R2-411 Tally ALTERID regressed"
    assert "<REFERENCE>" in src, "R2-411 Tally reference tag regressed"


def test_pin_R2_089_project_status_buckets():
    src = _read("app/routers/analytics.py")
    assert 'status_counts["Other"] += 1' in src, "R2-089 Other status bucket regressed"
    assert '"Cancelled": 0' in src, "R2-089 Cancelled status bucket regressed"
    assert '"Planning": 0' in src, "R2-089 Planning status bucket regressed"


def test_pin_R2_309_sentry_release_wired():
    main = _read("app/main.py")
    config = _read("app/config.py")
    assert "release=_app_settings.SENTRY_RELEASE or None" in main, "R2-309 Sentry release wiring regressed"
    assert "SENTRY_RELEASE: str = \"\"" in config, "R2-309 Sentry release setting regressed"


def test_pin_R2_496_three_way_po_amount_formatted_inr():
    src = _read_frontend("src/app/c/[company_id]/d/three-way/page.tsx")
    assert "fmtINR(m.po_amount)" in src, "R2-496 three-way PO amount INR formatting regressed"
    assert "toLocaleString" not in src, "R2-496 toLocaleString fallback reintroduced"


def test_pin_R2_115_no_demo_uuid_in_company_settings():
    src = _read("app/routers/settings.py")
    body = src.split("def get_company_settings", 1)[1]
    assert "e0000000-0000-0000-0000-000000000000" not in body, "R2-115 demo UUID fallback reintroduced in get_company_settings"


def test_pin_R2_290_breakup_and_gstin_validation():
    src = _read("app/routers/settings.py")
    assert "breakup components must sum to 100" in src, "R2-290 breakup sum validation regressed"
    assert 'pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"' in src, "R2-290 GSTIN pattern validation regressed"


def test_pin_R2_548_settings_literals_and_decimals():
    src = _read("app/routers/settings.py")
    assert 'Literal["Project Level", "Company Level"]' in src, "R2-548 grn_numbering literal regressed"
    assert 'Literal["company", "branch"]' in src, "R2-548 document company display literal regressed"
    assert "Field(None, ge=0, le=4)" in src, "R2-548 decimal places bounds regressed"


def test_pin_R2_129_statutory_due_date_derivation():
    from datetime import datetime
    from app.routers.statutory import calculate_due_date
    assert calculate_due_date("pf", "2026-07") == datetime(2026, 8, 15), "R2-129 PF due date derivation regressed"
    assert calculate_due_date("tds", "2026-06") == datetime(2026, 7, 7), "R2-129 TDS due date derivation regressed"
    assert calculate_due_date("pf", "2026-12") == datetime(2027, 1, 15), "R2-129 year-rollover due date derivation regressed"


def test_pin_R2_130_no_penalty_calculator():
    src = _read("app/routers/statutory.py")
    assert "calculate_penalty" not in src, "R2-130 penalty calculator reintroduced"


def test_pin_R2_505_no_internal_phase_labels_on_production():
    import re
    src = _read_frontend("src/app/c/[company_id]/d/production/page.tsx")
    assert not re.search(r"PHASE 1[0-9]", src), "R2-505 internal phase label reintroduced on production page"


def test_pin_R2_461_cpm_backward_pass_timedeltas():
    src = _read("app/routers/planning.py")
    assert "timedelta(days=request.duration_days - 1)" in src, "R2-461 task end-date timedelta regressed"
    assert "timedelta(days=dur_by_id.get(s, 1))" in src, "R2-461 CPM backward pass timedelta regressed"


def test_pin_R2_566_task_default_and_create_status():
    src = _read("app/routers/planning.py")
    assert 'status: str = "not_started"' in src, "R2-566 task default status regressed"
    assert "status=request.status," in src, "R2-566 task create status wiring regressed"


def test_pin_R2_135_depreciation_method_and_book_value_guards():
    src = _read("app/routers/assets.py")
    assert 'pattern="^(straight_line|wdv)$"' in src, "R2-135 depreciation method pattern regressed"
    assert "accumulated_depreciation must equal the prior accumulated total" in src, "R2-135 accumulated total guard regressed"
    assert "book_value cannot fall below the schedule's salvage_value" in src, "R2-135 book value floor guard regressed"


def test_pin_R2_256_incident_close_audit_and_lost_time_guard():
    src = _read("app/routers/safety.py")
    assert "incident.closed_by = current_user.id" in src, "R2-256 incident close auditor regressed"
    assert "lost_time_days: int = Field(0, ge=0)" in src, "R2-256 lost time days guard regressed"
    assert "reported_at cannot be in the future" in src, "R2-256 future reported_at rejection regressed"
    models = _read("app/models.py")
    assert 'closed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"' in models, "R2-256 incident closed_by FK regressed"


def test_pin_R2_532_safety_create_schemas_typed_ids():
    src = _read("app/routers/safety.py")
    assert src.count("project_id: uuid.UUID") >= 3, "R2-532 safety create schema project_id typing regressed"
    assert "conducted_at: datetime" in src, "R2-532 toolbox talk conducted_at typing regressed"
    assert "check_date: datetime" in src, "R2-532 PPE check check_date typing regressed"
    assert "uuid.UUID(payload" not in src, "R2-532 untyped uuid.UUID(payload coercion reintroduced"


def test_pin_R2_174_txn_party_name_resolves_library_party():
    # R2-131: _txn_party_name routes through the shared resolve_party_name helper;
    # R2-174's LibraryParty resolution now lives in app/party_names.py itself.
    src = _read("app/routers/finance.py")
    assert "from app.party_names import resolve_party_name" in src, "R2-174 finance party-name import regressed"
    body = src.split("def _txn_party_name", 1)[1].split("def ", 1)[0]
    assert 'resolve_party_name(db, team_id, fallback="Unknown Party")' in body, "R2-174 _txn_party_name no longer routes through the shared resolver"
    helper = _read("app/party_names.py")
    assert "team.library_party_id" in helper, "R2-174 shared resolver no longer walks library_party_id"
    assert "models.LibraryParty" in helper, "R2-174 shared resolver no longer resolves through LibraryParty"


def test_pin_R2_176_upload_content_type_sniffing():
    src = _read("app/routers/files.py")
    assert "ALLOWED_CONTENT_TYPES" in src, "R2-176 upload content-type allowlist regressed"
    assert "_sniff_content_type" in src, "R2-176 upload content-type sniffing regressed"
    assert "download=true" in src, "R2-176 signed URL download param regressed"


def test_pin_R2_489_quality_inspector_options_no_dash_placeholder():
    d = _read_frontend("src/app/c/[company_id]/d/quality/page.tsx")
    p = _read_frontend("src/app/c/[company_id]/p/[project_id]/quality/page.tsx")
    frag = 'filter((name) => name && name !== "\u2014")'
    for src in (d, p):
        assert frag in src, "R2-489 inspector options dash placeholder reintroduced"


def test_pin_R2_227_planning_is_pinned_default():
    src = _read("app/routers/planning.py")
    assert "is_pinned: bool = False" in src, "R2-227 planning is_pinned default regressed"


def test_pin_R2_287_project_party_opening_balance_guards():
    src = _read("app/routers/projects.py")
    assert 'pattern="^(will_pay|will_receive)$"' in src, "R2-287 project party direction pattern regressed"
    assert "opening_balance_amount: Optional[float] = Field(0.0, ge=0)" in src, "R2-287 opening balance negative guard regressed"


def test_pin_R2_492_project_member_company_team_join():
    src = _read("app/routers/projects.py")
    assert "models.ProjectMember.company_team_id == models.CompanyTeam.id" in src, "R2-492 project member company-team join regressed"


def test_pin_R2_370_bill_cancel_audit():
    src = _read("app/routers/billing.py")
    assert '@router.post("/bills/{bill_id}/cancel"' in src, "R2-370 bill cancel endpoint regressed"
    assert "bill.cancelled_at = datetime.now(timezone.utc)" in src, "R2-370 bill cancel audit timestamp regressed"
    models = _read("app/models.py")
    assert "cancelled_at = Column(DateTime(timezone=True), nullable=True)" in models, "R2-370 bill cancelled_at column regressed"


def test_pin_R2_514_help_approval_note_and_no_rollout_claim():
    src = _read_frontend("src/app/c/[company_id]/d/help/helpContent.tsx")
    assert "approval rules defined here are not" in src, "R2-514 help approval-rules disclaimer regressed"
    assert "rolled out category by category" not in src, "R2-514 fabricated rollout claim reintroduced"


def test_pin_R2_048_help_module_links_exported_and_modules_section():
    src = _read_frontend("src/app/c/[company_id]/d/help/helpContent.tsx")
    assert "export const HELP_MODULE_LINKS" in src, "R2-048 HELP_MODULE_LINKS export regressed"
    page = _read_frontend("src/app/c/[company_id]/d/help/page.tsx")
    assert "Modules" in page, "R2-048 Modules directory section regressed"


def test_pin_R2_102_tally_voucher_template_sf_prefix():
    src = _read("app/models.py")
    assert 'default="SF-{year}-{number}"' in src, "R2-102 Tally voucher SF template default regressed"
    assert "ONS-{year}-{number}" not in src, "R2-102 unexplained ONS- prefix reintroduced"


def test_pin_R2_114_gstin_checksum_validation():
    src = _read("app/routers/settings.py")
    assert "_gstin_checksum_ok" in src, "R2-114 GSTIN checksum helper regressed"
    assert "GSTIN check digit is invalid" in src, "R2-114 GSTIN check digit rejection regressed"


def test_pin_R2_452_no_float_limit_rounding_in_budgeting():
    src = _read("app/routers/budgeting.py")
    assert "quantity = round(quantity, float_limit)" not in src, "R2-452 float_limit rounding reintroduced"


def test_pin_R2_122_boq_document_item_create_endpoint():
    src = _read("app/routers/budgeting.py")
    assert '@router.post("/boq-documents/{doc_id}/items"' in src, "R2-122 BOQ document item create endpoint regressed"


def test_pin_R2_145_chat_team_members_fetch_and_placeholder():
    src = _read_frontend("src/app/c/[company_id]/d/chat/page.tsx")
    assert "apis/v3/crm/team-members/" in src, "R2-145 chat team members fetch regressed"
    assert "Select a team member" in src, "R2-145 team member placeholder regressed"


def test_pin_R2_146_chat_no_active_project_hint():
    src = _read_frontend("src/app/c/[company_id]/d/chat/page.tsx")
    assert 'No active project selected. Pick a project from the "Pinned Projects" dropdown' in src, "R2-146 no-active-project hint regressed"


def test_pin_R2_578_chat_server_stamps_sender_identity():
    src = _read("app/routers/chat.py")
    assert "msg.user_id = ct.id" in src, "R2-578 chat sender user_id stamping regressed"
    assert "msg.user_name = current_user.name" in src, "R2-578 chat sender user_name stamping regressed"


def test_pin_R2_147_chat_poll_since_id_and_member_count_group_by():
    src = _read("app/routers/chat.py")
    assert "since_id: Optional[uuid.UUID] = None" in src, "R2-147 chat poll since_id cursor regressed"
    assert "func.count(ChatGroupMember.id)" in src, "R2-147 member_count single GROUP BY regressed"


def test_pin_R2_150_todo_creator_derived_from_membership():
    src = _read("app/routers/todos.py")
    assert "membership = get_company_membership" in src, "R2-150 todo membership lookup regressed"
    assert "created_by=membership.id" in src, "R2-150 todo creator derivation regressed"
    assert "created_by: Optional[uuid.UUID] = None" not in src, "R2-150 untyped optional created_by reintroduced"


def test_pin_R2_443_todo_overdue_flag():
    src = _read("app/routers/todos.py")
    assert '"is_overdue": is_overdue' in src, "R2-443 todo is_overdue flag regressed"


def test_pin_R2_183_gstin_validator_and_pattern_in_auth():
    src = _read("app/routers/auth.py")
    assert "_validate_gstin" in src, "R2-183 GSTIN validator no longer wired into auth"
    assert 'pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"' in src, "R2-183 GSTIN pattern validation regressed"


def test_pin_R2_191_company_team_unique_membership():
    src = _read("app/models.py")
    assert "uq_company_team_company_id_user_id" in src, "R2-191 company-team membership unique constraint regressed"


def test_pin_R2_206_wastage_type_pattern_and_reporter():
    src = _read("app/routers/wastage.py")
    assert "pattern=WASTAGE_TYPE_PATTERN" in src, "R2-206 wastage type pattern guard regressed"
    assert "reported_by=membership.id" in src, "R2-206 wastage reporter derivation regressed"
    constants = _read("app/constants.py")
    assert "WASTAGE_TYPE_PATTERN" in constants, "R2-206 WASTAGE_TYPE_PATTERN constant regressed"


def test_pin_R2_207_production_scales_by_wastage_pct():
    src = _read("app/routers/production.py")
    assert "float(recipe.wastage_pct) / 100.0" in src, "R2-207 production wastage allowance scaling regressed"


def test_pin_R2_225_timesheet_save_surfaces_error():
    src = _read_frontend("src/app/c/[company_id]/d/team-action/page.tsx")
    assert "setTsFormError" in src, "R2-225 timesheet form error state regressed"
    assert "!tsPartyId) return;" not in src, "R2-225 silent timesheet save early-return reintroduced"


def test_pin_R2_261_dpr_duplicate_date_409():
    src = _read("app/routers/dpr.py")
    assert "A Daily Progress Report already exists for this project on this date" in src, "R2-261 DPR duplicate-date rejection message regressed"
    assert "status_code=409" in src, "R2-261 DPR duplicate-date conflict status regressed"


def test_pin_R2_247_quality_records_stamp_session_user():
    src = _read("app/routers/quality.py")
    assert "inspected_by=current_user.id" in src, "R2-247 inspection auditor derivation regressed"
    assert "raised_by=current_user.id" in src, "R2-247 NCR raiser derivation regressed"


def test_pin_R2_361_no_quotation_model():
    src = _read("app/models.py")
    assert "class Quotation" not in src, "R2-361 dead Quotation model reintroduced"


def test_pin_R2_282_calculator_legacy_alias_conflict():
    src = _read("app/routers/calculators.py")
    assert "Provide either the legacy fields or their aliases, not both" in src, "R2-282 legacy/alias conflict rejection regressed"
    assert "Field(1, ge=1" in src, "R2-282 floors minimum guard regressed"


def test_pin_R2_508_ltif_basis_no_osha_claim():
    src = _read("app/routers/safety.py")
    assert "ltif_basis: int = 200000" in src, "R2-508 LTIF basis default regressed"
    page = _read_frontend("src/app/c/[company_id]/d/safety/page.tsx")
    assert "OSHA-aligned" not in page, "R2-508 OSHA-aligned claim reintroduced on safety page"


def test_pin_R2_537_log_deletion_defers_commit_to_caller():
    src = _read("app/routers/delete_logs.py")
    body = src.split("def log_deletion", 1)[1].split("def ", 1)[0]
    assert "db.commit()" not in body, "R2-537 log_deletion no longer defers commit to the caller"
    assert "db.add(log)" in body, "R2-537 log_deletion no longer queues the audit row"


def test_pin_R2_118_hr_holidays_fetch():
    src = _read_frontend("src/app/c/[company_id]/d/hr/page.tsx")
    assert "apis/v3/hr/holidays/${companyId}" in src, "R2-118 HR holidays fetch wiring regressed"


def test_pin_R2_218_billing_refetch_after_subcon_import():
    src = _read_frontend("src/app/c/[company_id]/d/billing/page.tsx")
    assert "fetchBills(subconNameMap)" in src, "R2-218 billing refetch after subcon name map build regressed"


def test_pin_R2_501_analytics_inr_formatting():
    src = _read_frontend("src/app/c/[company_id]/analytics/page.tsx")
    assert "fmtINR(" in src, "R2-501 analytics INR formatting regressed"


def test_pin_R2_004_calculators_wastage_allowance_labels():
    src = _read_frontend("src/app/c/[company_id]/d/reports/calculators/page.tsx")
    assert "Includes {concreteWastage}% wastage allowance" in src, "R2-004 concrete wastage allowance label regressed"
    assert "Includes {plasterWastage}% wastage allowance" in src, "R2-004 plaster wastage allowance label regressed"


def test_pin_R2_521_steel_unit_weight_162_formula():
    src = _read("app/calc_shared.py")
    assert "STEEL_DIVISOR = 162.0" in src or "/ 162.0" in src or "/ STEEL_DIVISOR" in src, "R2-521 steel unit-weight formula regressed"


def test_pin_R2_134_three_way_match_tolerance():
    src = _read("app/routers/three_way.py")
    assert "MATCH_TOLERANCE_PCT = 0.01" in src, "R2-134 match tolerance pct regressed"
    assert "tolerance = max(MATCH_TOLERANCE_MIN, abs(po_amount) * MATCH_TOLERANCE_PCT)" in src, "R2-134 three-way match gate regressed"
    assert 'match_status = "matched" if abs(variance) <= tolerance' in src, "R2-134 server-computed verdict regressed"


def test_pin_R2_154_budget_po_wo_status_filters():
    src = _read("app/routers/budget.py")
    assert 'PurchaseOrder.status.in_(("sent", "partial", "received"))' in src, "R2-154 PO status filter regressed"
    assert 'WorkOrder.status != "cancelled"' in src, "R2-154 WO cancelled exclusion regressed"


def test_pin_R2_159_custom_field_patterns():
    src = _read("app/routers/custom_fields.py")
    assert "pattern=CUSTOM_FIELD_ENTITY_TYPE_PATTERN" in src, "R2-159 entity type pattern regressed"
    assert "pattern=CUSTOM_FIELD_TYPE_PATTERN" in src, "R2-159 field type pattern regressed"


def test_pin_R2_269_hr_employee_code_label():
    src = _read("app/routers/hr.py")
    assert '"Employee Code"' in src, "R2-269 Employee Code header regressed"


def test_pin_R2_273_crm_lead_email_and_closure_validator():
    src = _read("app/routers/crm.py")
    assert "email: Optional[EmailStr] = None" in src, "R2-273 lead email typing regressed"
    assert "expected_closure must not be in the past" in src, "R2-273 expected_closure past-date validator regressed"


def test_pin_R2_293_tally_onsite_transaction_literal():
    src = _read("app/routers/tally.py")
    assert 'Literal["Material Purchase", "Subcon Expense", "Sales Invoice"]' in src, "R2-293 onsite transaction type literal regressed"


def test_pin_R2_295_rate_limit_storage_uri():
    src = _read("app/rate_limit.py")
    assert "RATE_LIMIT_STORAGE_URI" in src, "R2-295 rate-limit storage URI wiring regressed"


def test_pin_R2_331_wastage_status_pattern():
    src = _read("app/routers/wastage.py")
    assert "pattern=WASTAGE_STATUS_PATTERN" in src, "R2-331 wastage status pattern regressed"


def test_pin_R2_367_drawing_revision_approval_status_audit():
    src = _read("app/routers/drawings.py")
    assert 'pattern="^(approved|rejected|pending)$"' in src, "R2-367 revision approval pattern regressed"
    assert 'revision.approved_by = None if req.approval_status == "pending" else membership.id' in src, "R2-367 revision approval auditor regressed"


def test_pin_R2_376_tower_rollup_untagged_variance():
    src = _read("app/routers/towers.py")
    assert "tower_id=None" in src, "R2-376 untagged tower rollup regressed"
    assert "variance=total_budget - total_billed" in src, "R2-376 tower variance derivation regressed"


def test_pin_R2_379_advance_recovery_guard():
    src = _read("app/routers/billing.py")
    assert "advance_recovery_total" in src, "R2-379 advance recovery total regressed"
    assert "exceeds the party's remaining project advance" in src, "R2-379 advance recovery overshoot rejection regressed"


def test_pin_R2_398_report_export_columns_and_formatter():
    src = _read_frontend("src/app/c/[company_id]/reports/[slug]/page.tsx")
    assert "exportColumns" in src, "R2-398 report export column filter regressed"
    assert "formatExportCell" in src, "R2-398 report export cell formatter regressed"


def test_pin_R2_504_asset_depreciation_pct_round_guard():
    src = _read("app/routers/assets.py")
    assert "round(payload.depreciation_pct, 2) != round(max_pct, 2)" in src, "R2-504 depreciation pct rounding guard regressed"


def test_pin_R2_512_backfill_rbac_endpoint_singleton():
    src = _read("app/routers/admin_migrations.py")
    assert src.count('@router.post("/backfill-rbac")') == 1, "R2-512 backfill-rbac endpoint count regressed"


def test_pin_R2_535_vendor_performance_po_normalization():
    src = _read("app/routers/vendor_performance.py")
    assert "func.lower(func.trim(PurchaseOrder.po_number))" in src, "R2-535 vendor PO number normalization regressed"


def test_pin_R2_553_face_confidence_score_bounds():
    src = _read("app/routers/face_recognition.py")
    assert "Field(None, ge=0, le=1)" in src, "R2-553 face confidence score bounds regressed"


def test_pin_R2_555_library_schema_name_max_length():
    src = _read("app/routers/library.py")
    assert "name: str = Field(..., max_length=255)" in src, "R2-555 library schema name max_length regressed"


def test_pin_R2_558_main_integrity_error_handler():
    src = _read("app/main.py")
    assert "@app.exception_handler(IntegrityError)" in src, "R2-558 global IntegrityError handler regressed"
    assert "Record is still referenced by another row" in src, "R2-558 IntegrityError 409 detail regressed"


def test_pin_R2_088_anchored_static_mount():
    src = _read("app/main.py")
    assert "backend/static" in src, "R2-088 anchored static mount regressed"


def test_pin_R2_217_drawing_pin_patch_route():
    src = _read("app/routers/drawings.py")
    assert '@router.patch("/pins/{pin_id}")' in src, "R2-217 drawing pin patch route regressed"


def test_pin_R2_278_todo_url_allowlist():
    src = _read("app/routers/todos.py")
    assert 'v.startswith("http://") or v.startswith("https://")' in src, "R2-278 todo url scheme allowlist regressed"


def test_pin_R2_077_report_export_schemas_removed():
    src = _read_frontend("src/app/c/[company_id]/reports/[slug]/page.tsx")
    assert "exportSchemas" not in src, "R2-077 dead exportSchemas reintroduced"


def test_pin_R2_056_payroll_attendance_error_toast():
    src = _read_frontend("src/app/c/[company_id]/d/payroll-attendance/page.tsx")
    assert 'Could not add designation: ${e?.message ?? "unknown error"}' in src, "R2-056 payroll-attendance error toast regressed"


def test_pin_R2_082_analytics_subcon_name_resolution():
    src = _read("app/routers/analytics.py")
    assert "library_party_id" in src, "R2-082 scorecard library_party_id resolution regressed"


def test_pin_R2_078_no_notification_fabrication_in_header():
    src = _read_frontend("src/components/PageHeader.tsx")
    assert "siteflow_notifications" not in src, "R2-078 fabricated notification table reintroduced"
    assert "seedNotifications" not in src, "R2-078 seeded notifications reintroduced"


def test_pin_R2_103_finance_sf_prefix_only():
    src = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert "ONS-V-" not in src, "R2-103 ONS- voucher prefix reintroduced"
    assert "SF-V-" in src, "R2-103 SF- voucher prefix regressed"


def test_pin_R2_124_equipment_empty_states():
    d = _read_frontend("src/app/c/[company_id]/d/equipment/page.tsx")
    p = _read_frontend("src/app/c/[company_id]/p/[project_id]/equipment/page.tsx")
    for src in (d, p):
        assert "No equipment yet" in src, "R2-124 equipment empty state regressed"


def test_pin_R2_208_safety_attendee_count_guard():
    src = _read("app/routers/safety.py")
    assert "attendee_count: int = Field(0, ge=0)" in src, "R2-208 toolbox attendee count guard regressed"


def test_pin_R2_402_po_pdf_received_header():
    src = _read("app/routers/procurement.py")
    assert 'table_headers = ["Material", "Qty", "Unit", "Rate", "Tax%", "Amount", "Received"]' in src, "R2-402 PO-PDF Received header regressed"


def test_pin_R2_420_finance_abs_balance_and_project_name():
    page = _read_frontend("src/app/c/[company_id]/d/finance/page.tsx")
    assert "Math.abs(p.balance" in page, "R2-420 finance abs balance render regressed"
    finance = _read("app/routers/finance.py")
    assert "project_name=project_name_by_id" in finance, "R2-420 finance project name resolution regressed"


def test_pin_R2_436_mom_creator_not_in_form():
    d = _read_frontend("src/app/c/[company_id]/d/mom/page.tsx")
    p = _read_frontend("src/app/c/[company_id]/p/[project_id]/mom/page.tsx")
    for src in (d, p):
        assert "form.created_by" not in src, "R2-436 client-stamped MOM creator reintroduced"
    src = _read("app/routers/mom.py")
    assert "created_by=current_user.name," in src, "R2-436 MOM creator session derivation regressed"


def test_pin_R2_446_mom_statuses_include_draft():
    # Both MOM pages render the shared MomRegister since 2026-10-27.
    for page in ("src/app/c/[company_id]/d/mom/page.tsx", "src/app/c/[company_id]/p/[project_id]/mom/page.tsx"):
        assert "MomRegister" in _read_frontend(page), f"{page} no longer uses MomRegister"
    src = _read_frontend("src/components/MomRegister.tsx")
    assert '"Draft"' in src and '"Action Pending"' in src, "R2-446 MOM Draft status regressed"


def test_pin_R2_460_gantt_fmt_date_helper():
    src = _read_frontend("src/app/c/[company_id]/d/planning/gantt/page.tsx")
    assert "fmtDate(" in src, "R2-460 gantt fmtDate helper regressed"
    assert "toLocaleDateString" not in src, "R2-460 gantt locale date render reintroduced"


def test_pin_R2_144_chat_no_media_fields():
    src = _read("app/routers/chat.py")
    assert "media_url" not in src, "R2-144 chat media_url reintroduced"
    assert "voice_note_url" not in src, "R2-144 chat voice_note_url reintroduced"


def test_pin_R2_162_calculators_sar_currency():
    # R2-162 removed the dead currency selector; R2-161 later dropped the invented
    # city-multiplier/currency table entirely, so the correct state is: no
    # fabricated multi-currency surface at all.
    src = _read_frontend("src/app/c/[company_id]/d/reports/calculators/page.tsx")
    assert 'cur: "SAR"' not in src, "R2-162 fabricated per-city currency table reintroduced"
    assert "Currency Mode" not in src, "R2-162 fabricated currency selector reintroduced"
    assert "houseCurrency" not in src, "R2-162 houseCurrency fallback reintroduced"


def test_pin_R2_164_calculators_application_allowance():
    src = _read_frontend("src/app/c/[company_id]/d/reports/calculators/page.tsx")
    assert "10% application allowance" in src, "R2-164 paint application allowance regressed"


def test_pin_R2_467_drawings_active_revision_and_status():
    src = _read_frontend("src/app/c/[company_id]/d/drawings/page.tsx")
    assert "registerActiveRev" in src, "R2-467 drawings active revision derivation regressed"
    assert "approvalStatus" in src, "R2-467 drawings approval status render regressed"


def test_pin_R2_472_chat_url_allowlist():
    src = _read_frontend("src/app/c/[company_id]/d/chat/page.tsx")
    assert "/^https?:\\/\\//i.test" in src, "R2-472 chat url scheme allowlist regressed"


def test_pin_R2_486_calculators_paint_coverage_no_mode():
    src = _read_frontend("src/app/c/[company_id]/d/reports/calculators/page.tsx")
    assert "115 sqft/L" in src, "R2-486 paint coverage label regressed"
    assert "paintMode" not in src, "R2-486 paintMode reintroduced"


def test_pin_R2_493_transaction_zatca_column():
    src = _read_frontend("src/app/c/[company_id]/p/[project_id]/transaction/page.tsx")
    assert "zatcaEnabled &&" in src, "R2-493 ZATCA column gate regressed"


def test_pin_R2_563_timesheet_entry_week_window():
    src = _read("app/routers/hr.py")
    assert "week_start <= entry_date <= week_end" in src, "R2-563 timesheet week window validator regressed"


def test_pin_R2_596_timesheet_error_surfaces():
    import re
    src = _read_frontend("src/app/c/[company_id]/d/hr/page.tsx")
    assert re.search(r"catch[^{]*\{[^}]*setTimesheets", src) is None, "R2-596 setTimesheets inside a catch reintroduced"


def test_pin_R2_600_home_featured_project_filtered():
    src = _read_frontend("src/app/c/[company_id]/d/home/page.tsx")
    assert "filteredProjects[0]" in src, "R2-600 home featured project binding regressed"

# ── Phase H waves 1-3 ─────────────────────────────────────────────────────────

def test_pin_R2_182_storage_listener():
    src = _read_frontend("src/app/c/[company_id]/layout.tsx")
    assert 'window.addEventListener("storage", onStorage)' in src
    assert '"access_token"' in src

def test_pin_R2_186_switch_company():
    src = _read("app/routers/auth.py")
    assert '@router.post("/switch-company/{company_id}")' in src
    body = src.split("def switch_company", 1)[1].split("@router", 1)[0]
    assert "get_company_membership" in body
    assert "_mint_session_response" in body

def test_pin_R2_196_token_revocation():
    auth = _read("app/auth.py")
    assert '"jti"' in auth and '"iat"' in auth
    assert "models.RevokedToken" in auth
    src = _read("app/routers/auth.py")
    assert '@router.post("/logout")' in src
    assert "user.tokens_revoked_at" in src
    import os
    mig = os.path.join(ROOT, "..", "supabase", "migrations", "20260821_000002_token_revocation.sql")
    assert os.path.exists(mig)

def test_pin_R2_285_approval_rule_validation():
    src = _read("app/routers/settings.py")
    assert "max_amount must be greater than min_amount" in src
    assert "_validate_rule_approvers(db, company_id, rule_data.approvers)" in src
    assert "_reject_overlapping_band(" in src

def test_pin_R2_292_role_permission_guards():
    src = _read("app/routers/settings.py")
    assert "permissions cannot be empty" in src
    assert "Only owner-equivalent members may grant the all superuser flag" in src
    assert "_LOCKED_ROLES" in src

def test_pin_R2_405_mobile_not_phone():
    src = _read("app/routers/settings.py")
    assert "phone=u.mobile" in src
    assert "user.mobile if user else None" in src
    assert ".first().mobile" not in src
    assert "u.phone" not in src

def test_pin_R2_554_gstin_mod36():
    src = _read("app/routers/settings.py")
    body = src.split("def _gstin_checksum_ok", 1)[1].split("def ", 1)[0]
    assert "reversed(gstin[:14])" in body
    assert "(product // 36)" in body

def test_pin_R2_204_ncr_accountability():
    src = _read("app/routers/quality.py")
    assert "ncr.closed_by = current_user.id" in src
    assert "ncr.reviewed_by = current_user.id" in src

def test_pin_R2_212_incident_close_min_length():
    src = _read("app/routers/safety.py")
    assert src.count("min_length=10") >= 2

def test_pin_R2_363_foreign_checklist_item_rejected():
    src = _read("app/routers/quality.py")
    assert "does not belong to this inspection's checklist" in src

def test_pin_R2_364_unassessed_metric():
    src = _read("app/routers/reports.py")
    assert "quality_tests_unassessed" in src

def test_pin_R2_391_inspection_responses_endpoint():
    src = _read("app/routers/quality.py")
    assert "/inspections/{insp_id}/responses" in src

def test_pin_R2_551_acceptance_range_not_inverted():
    src = _read("app/routers/quality.py")
    assert "acceptance_range_not_inverted" in src

def test_pin_R2_525_penalty_reads_stored_wages():
    src = _read("app/routers/statutory.py")
    assert "No statutory report found for this report type and period" in src

def test_pin_R2_526_filed_by_server_derived():
    src = _read("app/routers/statutory.py")
    assert "report.filed_by = current_user.name" in src

def test_pin_R2_441_progress_vocab():
    src = _read("app/routers/projects.py")
    assert '"in_progress": 0.5' in src

def test_pin_R2_491_member_party_fallback():
    src = _read("app/routers/projects.py")
    body = src.split("def list_project_members", 1)[1].split("def ", 1)[0]
    assert "models.LibraryParty.id == m.library_party_id" in body

def test_pin_R2_552_project_bounds():
    src = _read("app/routers/projects.py")
    assert "project_value: float = Field(0.0, ge=0, le=1e15)" in src
    assert "attendance_radius_meters: int = Field(500, ge=0, le=100000)" in src
    hr = _read("app/routers/hr.py")
    assert "500 if project.attendance_radius_meters is None else project.attendance_radius_meters" in hr

def test_pin_R2_580_status_pattern():
    constants = _read("app/constants.py")
    assert 'CANONICAL_PROJECT_STATUSES = (\n    "Not Started", "Planning", "Ongoing", "On Hold", "Onhold", "Completed", "Cancelled",\n)' in constants
    assert 'PROJECT_STATUS_PATTERN = f"^({\'|\'.join(CANONICAL_PROJECT_STATUSES)})$"' in constants
    projects = _read("app/routers/projects.py")
    assert "PROJECT_STATUS_PATTERN" in projects
    assert "status: Optional[str] = Field(None, pattern=PROJECT_STATUS_PATTERN)" in projects
    planning = _read("app/routers/planning.py")
    assert "PROJECT_STATUS_PATTERN" in planning
    assert "status: Optional[str] = Field(None, pattern=PROJECT_STATUS_PATTERN)" in planning

def test_pin_R2_582_party_status_typed():
    src = _read("app/routers/projects.py")
    assert 'status: str = Field(..., pattern="^(Active|Inactive)$")' in src

def test_pin_R2_583_party_balance_update():
    src = _read("app/routers/projects.py")
    body = src.split("def add_project_party", 1)[1].split("@router", 1)[0]
    assert "existing.advance_paid = adv" in body

def test_pin_R2_202_boq_revision_applies():
    models = _read("app/models.py")
    assert "revised_amount = Column(Numeric(18, 2), nullable=True)" in models
    src = _read("app/routers/budgeting.py")
    assert "doc.revised_amount = req.revised_amount" in src

def test_pin_R2_338_vendor_perf_wired():
    vp = _read("app/routers/vendor_performance.py")
    assert "baseline = po.expected_delivery_date or po.po_date" in vp
    proc = _read("app/routers/procurement.py")
    assert "refresh_vendor_performance(db, req.project_id, req.company_id)" in proc

def test_pin_R2_340_progress_consumers():
    planning = _read("app/routers/planning.py")
    assert "task.progress = 100.0" in planning
    dpr = _read("app/routers/dpr.py")
    assert "sum(float(t.progress or 0) for t in tasks)" in dpr
    analytics = _read("app/routers/analytics.py")
    assert analytics.count("_task_is_completed(") >= 5

def test_pin_R2_382_edit_window_bills():
    src = _read("app/routers/billing.py")
    assert src.count("enforce_entry_editing_window(db, bill.company_id, bill.invoice_date)") >= 2

def test_pin_R2_230_revision_file_required():
    src = _read("app/routers/drawings.py")
    assert src.count("file_url cannot be blank") >= 2

def test_pin_R2_253_subcon_wo_cap():
    billing = _read("app/routers/billing.py")
    assert "Subcon bill exceeds work order" in billing
    models = _read("app/models.py")
    assert "wo_id = Column(UUID(as_uuid=True), ForeignKey" in models

def test_pin_R2_433_po_vendor_name():
    proc = _read("app/routers/procurement.py")
    assert "vendor_name=vendor_name" in proc

def test_pin_R2_559_doc_number_uniques():
    models = _read("app/models.py")
    for uq in ("uq_bills_company_id_invoice_number", "uq_purchase_orders_company_id_po_number",
               "uq_goods_receipt_notes_company_id_grn_number", "uq_material_indents_company_id_indent_number",
               "uq_work_orders_company_id_wo_number", "uq_library_cost_codes_company_id_code"):
        assert uq in models

def test_pin_R2_275_milestone_bounds():
    src = _read("app/routers/budgeting.py")
    assert "milestone_done cannot exceed" in src

def test_pin_R2_334_cost_code_library_gate():
    src = _read("app/routers/budgeting.py")
    assert "Unknown cost codes" in src

def test_pin_R2_177_work_order_cancel():
    src = _read("app/routers/billing.py")
    assert 'wo.status = "cancelled"' in src

def test_pin_R2_723_active_bills_cancelled_filter():
    src = _read("app/bill_scope.py")
    assert 'status != "Cancelled"' in src

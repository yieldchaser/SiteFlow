"""
test_calculator_parity.py - Client-Server Parity Test Suite for Civil Calculators

Part 13: Decided calculator duplication.
The frontend performs arithmetic client-side (PWA / offline capability in
components/resources/CalculatorTools.tsx and src/lib/calc-shared.ts).
This suite guarantees that backend endpoints in app/routers/calculators.py
produce identical results to the frontend client formulas for all 13 calculators:
1. steel (/calculators/steel)
2. concrete (/calculators/concrete)
3. rmc (/calculators/rmc)
4. brick (/calculators/brick)
5. brickwork (/calculators/brickwork)
6. paint (/calculators/paint)
7. tile (/calculators/tile)
8. flooring (/calculators/flooring)
9. plaster (/calculators/plaster)
10. plastering (/calculators/plastering)
11. waterproofing (/calculators/waterproofing)
12. billing (/calculators/billing)
13. split-rate (/calculators/split-rate)
(+ house-cost /calculators/house-cost)
"""

import math
import uuid
import pytest


_SUFFIX = uuid.uuid4().hex[:8]


def _mob(tag: int) -> str:
    return f"+9188{_SUFFIX}{tag:02d}"


def _mail(tag: int) -> str:
    return f"calc-parity-{tag}-{_SUFFIX}@test.com"


# ---------------------------------------------------------------------------
# 1. Steel Calculator Parity
# Frontend Client Formula: src/lib/calc-shared.ts:53-94 & CalculatorTools.tsx:701-850
# ---------------------------------------------------------------------------
def test_steel_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="SteelParity", user_name="UserSteel", mobile=_mob(1), email=_mail(1))
    hdr = auth_headers(user, comp)

    # Case A: Column Main Bars with lap length (50 * D)
    # Client formula: src/lib/calc-shared.ts:58-66
    dia = 16.0
    count = 8
    length = 3.5
    slab_thick = 0.15
    wastage = 5.0

    unit_w = (dia * dia) / 162.0
    lap_len = 50 * (dia / 1000.0)
    total_len = length + slab_thick + lap_len
    expected_weight = count * total_len * unit_w * (1 + wastage / 100.0)

    res = client.post(
        "/apis/v3/calculators/steel",
        json={
            "diameter": dia,
            "count": count,
            "length_or_height": length,
            "slab_thickness": slab_thick,
            "is_column": True,
            "wastage_pct": wastage,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["unit_weight_kg_m"] == round(unit_w, 4)
    assert data["total_length_m"] == round(total_len, 2)
    assert data["total_weight_kg"] == round(expected_weight, 2)

    # Case B: Slab bar count and distribution
    # Client formula: src/lib/calc-shared.ts:68-77
    span = 6.0
    spacing = 0.15
    bar_cnt = math.floor(span / spacing) + 1
    slab_expected_w = bar_cnt * length * unit_w * (1 + wastage / 100.0)

    res_slab = client.post(
        "/apis/v3/calculators/steel",
        json={
            "diameter": dia,
            "count": 1,
            "length_or_height": length,
            "span": span,
            "spacing": spacing,
            "wastage_pct": wastage,
        },
        headers=hdr,
    )
    assert res_slab.status_code == 200, res_slab.text
    data_slab = res_slab.json()
    assert data_slab["bar_count"] == bar_cnt
    assert data_slab["total_weight_kg"] == round(slab_expected_w, 2)


# ---------------------------------------------------------------------------
# 2. Concrete Volume & Mix Parity
# Frontend Client Formula: src/lib/calc-shared.ts:315-352 & CalculatorTools.tsx:523-690
# ---------------------------------------------------------------------------
def test_concrete_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="ConcParity", user_name="UserConc", mobile=_mob(2), email=_mail(2))
    hdr = auth_headers(user, comp)

    wet_vol = 10.0
    wastage = 5.0
    grade = "M20"

    # Client formula: dry_volume = wet_vol * 1.54 * (1 + wastage / 100.0)
    # Mix M20: 1:1.5:3, total = 5.5
    # Cement bags = (dry_vol * (1/5.5) * 1440) / 50
    dry_vol = wet_vol * 1.54 * (1 + wastage / 100.0)
    cement_bags = (dry_vol * (1.0 / 5.5) * 1440.0) / 50.0
    sand_m3 = dry_vol * (1.5 / 5.5)
    agg_m3 = dry_vol * (3.0 / 5.5)

    res = client.post(
        "/apis/v3/calculators/concrete",
        json={
            "wet_volume": wet_vol,
            "wastage_pct": wastage,
            "grade": grade,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["wet_volume_m3"] == round(wet_vol, 3)
    assert data["dry_volume_m3"] == round(dry_vol, 3)
    assert data["cement_bags"] == round(cement_bags, 2)
    assert data["sand_m3"] == round(sand_m3, 3)
    assert data["aggregate_m3"] == round(agg_m3, 3)
    assert data["engineered_design_mix_required"] is False


# ---------------------------------------------------------------------------
# 3. RMC Mixer Load Parity
# Frontend Client Formula: src/lib/calc-shared.ts:432-437 & CalculatorTools.tsx:1274-1350
# ---------------------------------------------------------------------------
def test_rmc_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="RMCParity", user_name="UserRMC", mobile=_mob(3), email=_mail(3))
    hdr = auth_headers(user, comp)

    pour_vol = 25.0
    mixer_size = 6.0
    wastage = 5.0

    total_vol = pour_vol * (1 + wastage / 100.0)
    mixer_loads = math.ceil(total_vol / mixer_size)

    res = client.post(
        "/apis/v3/calculators/rmc",
        json={
            "pour_volume": pour_vol,
            "mixer_size": mixer_size,
            "wastage_pct": wastage,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["total_volume_m3"] == round(total_vol, 3)
    assert data["mixer_loads"] == mixer_loads


# ---------------------------------------------------------------------------
# 4 & 5. Brick & Brickwork Parity (including alias route)
# Frontend Client Formula: src/lib/calc-shared.ts:505-538 & CalculatorTools.tsx:413-520
# ---------------------------------------------------------------------------
def test_brick_and_brickwork_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="BrickParity", user_name="UserBrick", mobile=_mob(4), email=_mail(4))
    hdr = auth_headers(user, comp)

    length = 5.0
    height = 3.0
    thickness = 230.0
    b_len = 190.0
    b_w = 90.0
    b_h = 90.0
    joint = 10.0
    wastage = 10.0

    # Client formula: src/lib/calc-shared.ts:505-538
    leaves = max(1, round(thickness / (b_w + joint)))
    face_area = ((b_len + joint) / 1000.0) * ((b_h + joint) / 1000.0)
    wall_area = length * height
    bricks_needed = math.ceil((wall_area / face_area) * leaves * (1 + wastage / 100.0))

    payload = {
        "length_m": length,
        "height_m": height,
        "thickness_mm": thickness,
        "brick_length_mm": b_len,
        "brick_width_mm": b_w,
        "brick_height_mm": b_h,
        "joint_mm": joint,
        "wastage_pct": wastage,
    }

    # Test /calculators/brick
    res1 = client.post("/apis/v3/calculators/brick", json=payload, headers=hdr)
    assert res1.status_code == 200, res1.text
    data1 = res1.json()
    assert data1["leaves"] == leaves
    assert data1["bricks_needed"] == bricks_needed
    assert data1["wall_area_m2"] == round(wall_area, 2)

    # Test alias /calculators/brickwork
    res2 = client.post("/apis/v3/calculators/brickwork", json=payload, headers=hdr)
    assert res2.status_code == 200, res2.text
    data2 = res2.json()
    assert data2["leaves"] == leaves
    assert data2["bricks_needed"] == bricks_needed


# ---------------------------------------------------------------------------
# 6. Paint Quantity Parity
# Frontend Client Formula: src/lib/calc-shared.ts:618-633 & CalculatorTools.tsx:267-370
# ---------------------------------------------------------------------------
def test_paint_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="PaintParity", user_name="UserPaint", mobile=_mob(5), email=_mail(5))
    hdr = auth_headers(user, comp)

    r_l = 15.0
    r_w = 12.0
    r_h = 10.0
    doors = 2
    windows = 3
    coats = 2
    quality = "premium"

    # Client formula: src/lib/calc-shared.ts:618-633
    wall_area = 2 * (r_l + r_w) * r_h + (r_l * r_w)  # with ceiling
    paintable = wall_area - (doors * 21.0) - (windows * 12.0)
    coverage = 135.0
    paint_litres = (paintable / coverage) * coats * 1.10
    putty_kg = (paintable / 100.0) * 5.5 * 1.10
    primer_litres = (paintable / 175.0) * 1.05

    res = client.post(
        "/apis/v3/calculators/paint",
        json={
            "room_length_ft": r_l,
            "room_width_ft": r_w,
            "ceiling_height_ft": r_h,
            "paint_ceiling": True,
            "doors_count": doors,
            "windows_count": windows,
            "coats": coats,
            "quality": quality,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["paintable_area_sqft"] == round(paintable, 2)
    assert data["paint_litres"] == round(paint_litres, 2)
    assert data["putty_kg"] == round(putty_kg, 2)
    assert data["primer_litres"] == round(primer_litres, 2)


# ---------------------------------------------------------------------------
# 7 & 8. Tile & Flooring Parity (including alias route)
# Frontend Client Formula: src/lib/calc-shared.ts:652-660
# ---------------------------------------------------------------------------
def test_tile_and_flooring_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="TileParity", user_name="UserTile", mobile=_mob(6), email=_mail(6))
    hdr = auth_headers(user, comp)

    length_ft = 12.0
    width_ft = 10.0
    tile_len_in = 24.0
    tile_wid_in = 24.0
    grout_mm = 2.0
    wastage = 10.0

    # Client formula: src/lib/calc-shared.ts:652-660
    room_area = length_ft * width_ft
    grout_in = grout_mm / 25.4
    tile_len_ft = (tile_len_in + grout_in) / 12.0
    tile_wid_ft = (tile_wid_in + grout_in) / 12.0
    single_area = tile_len_ft * tile_wid_ft
    tiles_needed = math.ceil((room_area / single_area) * (1 + wastage / 100.0))

    payload = {
        "length_ft": length_ft,
        "width_ft": width_ft,
        "tile_length_inch": tile_len_in,
        "tile_width_inch": tile_wid_in,
        "grout_mm": grout_mm,
        "wastage_pct": wastage,
    }

    # Test /calculators/tile
    res1 = client.post("/apis/v3/calculators/tile", json=payload, headers=hdr)
    assert res1.status_code == 200, res1.text
    data1 = res1.json()
    assert data1["room_area_sqft"] == round(room_area, 2)
    assert data1["tiles_needed"] == tiles_needed

    # Test alias /calculators/flooring
    res2 = client.post("/apis/v3/calculators/flooring", json=payload, headers=hdr)
    assert res2.status_code == 200, res2.text
    data2 = res2.json()
    assert data2["room_area_sqft"] == round(room_area, 2)
    assert data2["tiles_needed"] == tiles_needed


# ---------------------------------------------------------------------------
# 9 & 10. Plaster & Plastering Parity (including alias route)
# Frontend Client Formula: src/lib/calc-shared.ts:681-701
# ---------------------------------------------------------------------------
def test_plaster_and_plastering_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="PlasterParity", user_name="UserPlaster", mobile=_mob(7), email=_mail(7))
    hdr = auth_headers(user, comp)

    wall_area = 50.0
    thick_mm = 12.0
    mix = "1:4"
    wastage = 10.0

    # Client formula: src/lib/calc-shared.ts:681-701
    wet_vol = wall_area * (thick_mm / 1000.0)
    dry_vol = wet_vol * 1.33 * (1 + wastage / 100.0)
    cement_m3 = dry_vol * (1.0 / 5.0)
    cement_bags = (cement_m3 * 1440.0) / 50.0
    sand_m3 = dry_vol * (4.0 / 5.0)

    payload = {
        "wall_area_m2": wall_area,
        "thickness_mm": thick_mm,
        "mix_ratio": mix,
        "wastage_pct": wastage,
    }

    # Test /calculators/plaster
    res1 = client.post("/apis/v3/calculators/plaster", json=payload, headers=hdr)
    assert res1.status_code == 200, res1.text
    data1 = res1.json()
    assert data1["wet_volume_m3"] == round(wet_vol, 4)
    assert data1["dry_volume_m3"] == round(dry_vol, 4)
    assert data1["cement_bags"] == round(cement_bags, 2)
    assert data1["sand_m3"] == round(sand_m3, 3)

    # Test alias /calculators/plastering
    res2 = client.post("/apis/v3/calculators/plastering", json=payload, headers=hdr)
    assert res2.status_code == 200, res2.text
    data2 = res2.json()
    assert data2["cement_bags"] == round(cement_bags, 2)


# ---------------------------------------------------------------------------
# 11. Waterproofing Parity
# Frontend Client Formula: src/lib/calc-shared.ts:717-720
# ---------------------------------------------------------------------------
def test_waterproofing_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="WaterproofParity", user_name="UserWP", mobile=_mob(8), email=_mail(8))
    hdr = auth_headers(user, comp)

    area = 500.0
    cov = 60.0
    coats = 2
    wastage = 5.0

    # Client formula: src/lib/calc-shared.ts:717-720
    expected_litres = (area / cov) * coats * (1 + wastage / 100.0)

    res = client.post(
        "/apis/v3/calculators/waterproofing",
        json={
            "area_sqft": area,
            "coverage_sqft_per_litre": cov,
            "coats": coats,
            "wastage_pct": wastage,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["litres_needed"] == round(expected_litres, 2)


# ---------------------------------------------------------------------------
# 12. Billing Calculator Parity
# Frontend Client Formula: src/lib/calc-shared.ts:795-837
# ---------------------------------------------------------------------------
def test_billing_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="BillingParity", user_name="UserBill", mobile=_mob(9), email=_mail(9))
    hdr = auth_headers(user, comp)

    subtotal = 100000.0
    gst_pct = 18.0

    # Post-tax deductions
    res_post = client.post(
        "/apis/v3/calculators/billing",
        json={
            "subtotal": subtotal,
            "gst_pct": gst_pct,
            "deductions": [{"type": "pct_item_subtotal", "val": 2.0}],  # 2% of 100k = 2000
            "retentions": [{"type": "pct", "val": 5.0}],  # 5% of 118k = 5900
            "pre_tax_deductions": False,
        },
        headers=hdr,
    )
    assert res_post.status_code == 200, res_post.text
    d_post = res_post.json()
    assert d_post["subtotal"] == 100000.0
    assert d_post["gst_amount"] == 18000.0
    assert d_post["total_deductions"] == 2000.0
    assert d_post["total_retention"] == 5900.0
    assert d_post["net_payable"] == 118000.0 - 2000.0 - 5900.0


# ---------------------------------------------------------------------------
# 13. Split Rate Calculator Parity
# Frontend Client Formula: src/lib/calc-shared.ts:860-890
# ---------------------------------------------------------------------------
def test_split_rate_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="SplitParity", user_name="UserSplit", mobile=_mob(10), email=_mail(10))
    hdr = auth_headers(user, comp)

    qty = 10.0
    sup_rate = 200.0
    inst_rate = 50.0
    sup_tax = 18.0
    inst_tax = 12.0

    gross_sup = qty * sup_rate  # 2000
    gross_inst = qty * inst_rate  # 500
    s_tax = gross_sup * 0.18  # 360
    i_tax = gross_inst * 0.12  # 60
    tot_tax = s_tax + i_tax  # 420
    tot_amt = gross_sup + gross_inst + tot_tax  # 2920

    res = client.post(
        "/apis/v3/calculators/split-rate",
        json={
            "quantity": qty,
            "supply_rate": sup_rate,
            "installation_rate": inst_rate,
            "supply_tax_pct": sup_tax,
            "installation_tax_pct": inst_tax,
            "is_item_tax": True,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["gross_supply"] == round(gross_sup, 2)
    assert data["gross_installation"] == round(gross_inst, 2)
    assert data["gross_combined"] == round(gross_sup + gross_inst, 2)
    assert data["supply_tax"] == round(s_tax, 2)
    assert data["installation_tax"] == round(i_tax, 2)
    assert data["total_tax"] == round(tot_tax, 2)
    assert data["total_amount"] == round(tot_amt, 2)


# ---------------------------------------------------------------------------
# House Construction Cost Parity (Bonus)
# Frontend Client Formula: src/lib/calc-shared.ts:742-770 & CalculatorTools.tsx:1160-1250
# ---------------------------------------------------------------------------
def test_house_cost_calculator_parity(client, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="HouseParity", user_name="UserHouse", mobile=_mob(11), email=_mail(11))
    hdr = auth_headers(user, comp)

    area = 1500.0
    base_rate = 2200.0
    floors = 2
    wall_len = 120.0
    contingency = 10.0

    # Ground floor = 1500 * 2200 = 3,300,000
    # First floor = 1500 * (2200 * 1.12) = 3,696,000
    # Total construction = 6,996,000
    # Compound wall = 120 * (2200 * 0.35) = 92,400
    # Total project = 7,088,400
    tot_const = area * (base_rate * 1.0) + area * (base_rate * 1.12)
    wall_cost = wall_len * (base_rate * 0.35)
    tot_proj = tot_const + wall_cost
    contingency_buf = tot_proj * 0.10

    res = client.post(
        "/apis/v3/calculators/house-cost",
        json={
            "area_sqft": area,
            "base_rate": base_rate,
            "floors": floors,
            "is_commercial": False,
            "compound_wall_length_ft": wall_len,
            "contingency_pct": contingency,
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["base_construction_cost"] == round(tot_const, 2)
    assert data["compound_wall_cost"] == round(wall_cost, 2)
    assert data["total_project_cost"] == round(tot_proj, 2)
    assert data["contingency_buffer"] == round(contingency_buf, 2)
    assert data["splits"]["structure"] == round(tot_proj * 0.40, 2)

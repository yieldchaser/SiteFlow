"""
calc_shared.py  -  single source of truth for construction quantity calculators.
Mirrors frontend/src/lib/calc-shared.ts. CD-2 (R2-010): one shared module
consumed by both console and API. Drift is prevented by
tests/calculators-contract.test.ts fixed-input contract tests.

All functions are pure. The router (calculators.py) imports from here so
both sides compute from one source. No I/O, no DB.
"""
import math
from typing import Dict, Tuple, List

STEEL_DIVISOR = 162.0
CONCRETE_DRY_FACTOR = 1.54
CEMENT_DENSITY_KG_M3 = 1440.0
CEMENT_BAG_KG = 50.0
PLASTER_DRY_FACTOR = 1.33

PAINT_DOOR_AREA_SQFT = 21.0
PAINT_WINDOW_AREA_SQFT = 12.0
PAINT_COVERAGE_SQFT_PER_LITRE: Dict[str, float] = {
    "economy": 115.0,
    "premium": 135.0,
    "luxury": 155.0,
    "texture": 80.0,
}
PAINT_WASTAGE_FACTOR = 1.10
# kg per 100 sq ft for two coats on smooth plaster (Birla White: 1.5-2.0 sq m/kg,
# about 18 sq ft/kg). It was 2.25, less than half what the maker quotes.
PUTTY_KG_PER_SQFT_FACTOR = 5.5
PUTTY_WASTAGE = 1.10
PRIMER_DIVISOR = 175.0
PRIMER_WASTAGE = 1.05

CONCRETE_MIX_LIBRARY: Dict[str, Tuple[float, float, float]] = {
    "M7.5": (1.0, 4.0, 8.0),
    "M10": (1.0, 3.0, 6.0),
    "M15": (1.0, 2.0, 4.0),
    "M20": (1.0, 1.5, 3.0),
    "M25": (1.0, 1.0, 2.0),
}

CONCRETE_FRONTEND_FACTORS: Dict[str, Tuple[float, float, float]] = {
    "M5": (2.77, 0.48, 0.96),
    "M7_5": (3.41, 0.47, 0.94),
    "M10": (4.4, 0.46, 0.92),
    "M15": (6.3, 0.44, 0.88),
    "M20": (8.06, 0.42, 0.84),
    "M25": (11.1, 0.38, 0.77),
}

BRICK_PRESETS: Dict[str, Tuple[int, int, int]] = {
    "modular": (190, 90, 90),
    "traditional": (230, 110, 75),
    "uk": (215, 102, 65),
    "us": (203, 92, 95),
}


def _round2(n: float) -> float:
    return round(n, 2)


def _round3(n: float) -> float:
    return round(n, 3)


def _round4(n: float) -> float:
    return round(n, 4)


# Steel

def steel_unit_weight_kg_per_m(dia_mm: float) -> float:
    return (dia_mm * dia_mm) / STEEL_DIVISOR


def calc_steel_column_or_slab_or_stirrup(
    diameter: float,
    count: int,
    length_or_height: float,
    slab_thickness: float = 0.0,
    is_column: bool = False,
    spacing: float = 0.0,
    span: float = 0.0,
    hook_length_factor: int = 9,
    bend_deduction_factor: int = 2,
    cover: float = 0.04,
    main_width: float = 0.3,
    main_height: float = 0.4,
    wastage_pct: float = 5.0,
):
    unit_weight = steel_unit_weight_kg_per_m(diameter)
    if is_column:
        lap_length = 50 * (diameter / 1000.0)
        total_length = length_or_height + slab_thickness + lap_length
        total_weight = count * total_length * unit_weight * (1 + wastage_pct / 100.0)
        return {
            "unit_weight_kg_m": _round4(unit_weight),
            "total_weight_kg": _round2(total_weight),
            "total_length_m": _round2(total_length),
        }
    if spacing > 0 and span > 0:
        bar_count = int(math.floor(span / spacing)) + 1
        total_length = length_or_height
        total_weight = bar_count * total_length * unit_weight * (1 + wastage_pct / 100.0)
        return {
            "unit_weight_kg_m": _round4(unit_weight),
            "bar_count": bar_count,
            "total_weight_kg": _round2(total_weight),
        }
    a = main_width - 2 * cover
    b = main_height - 2 * cover
    hook_len = hook_length_factor * (diameter / 1000.0)
    bend_ded = bend_deduction_factor * (diameter / 1000.0)
    cutting_length = 2 * (a + b) + 2 * hook_len - 2 * bend_ded
    total_weight = count * cutting_length * unit_weight * (1 + wastage_pct / 100.0)
    return {
        "unit_weight_kg_m": _round4(unit_weight),
        "cutting_length_m": _round4(cutting_length),
        "total_weight_kg": _round2(total_weight),
    }


def calc_steel_column_frontend(
    col_height_mm: float,
    slab_thick_mm: float,
    size_a_mm: float,
    size_b_mm: float,
    main_bar_dia_mm: float,
    main_bar_count: int,
    stirrup_dia_mm: float,
    stirrup_spacing_mm: float,
    col_bar2_dia_mm: float = 0,
    col_bar2_count: int = 0,
    col_sp_end_mm: float = 0,
    col_sp_mid_mm: float = 0,
    wastage_pct: float = 5.0,
    steel_price_per_kg: float = 0,
):
    unit_w1 = steel_unit_weight_kg_per_m(main_bar_dia_mm)
    h_m = col_height_mm / 1000
    slab_m = slab_thick_mm / 1000
    lap_m = (50 * main_bar_dia_mm) / 1000
    bar1_len = (h_m + slab_m + lap_m) * main_bar_count
    bar1_w = bar1_len * unit_w1

    bar2_w = 0.0
    if col_bar2_dia_mm > 0 and col_bar2_count > 0:
        unit_w2 = steel_unit_weight_kg_per_m(col_bar2_dia_mm)
        lap2 = (50 * col_bar2_dia_mm) / 1000
        len2 = (h_m + slab_m + lap2) * col_bar2_count
        bar2_w = len2 * unit_w2

    stir_unit_w = steel_unit_weight_kg_per_m(stirrup_dia_mm)
    stir_len = (2 * ((size_a_mm - 80) + (size_b_mm - 80)) + 6 * stirrup_dia_mm) / 1000
    lo = max(col_height_mm / 6, max(size_a_mm, size_b_mm), 450)
    sp_end = col_sp_end_mm or stirrup_spacing_mm
    sp_mid = col_sp_mid_mm or stirrup_spacing_mm
    end_count = math.ceil(lo / sp_end) + 1 if sp_end else 0
    mid_count = max(0, math.floor((col_height_mm - 2 * lo) / sp_mid) - 1) if sp_mid else 0
    total_stirrups = 2 * end_count + mid_count
    stir_w = stir_len * total_stirrups * stir_unit_w

    net_w = bar1_w + bar2_w + stir_w
    tot_w = net_w * (1 + wastage_pct / 100)
    cost = tot_w * steel_price_per_kg if steel_price_per_kg > 0 else 0
    return {
        "bar1WeightKg": bar1_w,
        "bar2WeightKg": bar2_w,
        "stirrupWeightKg": stir_w,
        "totalWeightKg": tot_w,
        "cost": cost,
        "stirEndCount": end_count,
        "stirMidCount": mid_count,
        "stirrupCount": total_stirrups,
    }


def calc_slab_steel_frontend(
    slab_length_mm: float,
    slab_width_mm: float,
    main_dia_mm: float,
    main_spacing_mm: float,
    dist_dia_mm: float,
    dist_spacing_mm: float,
    dev_len_mm: float,
    wastage_pct: float = 5.0,
    price_per_kg: float = 0,
):
    unit_main = steel_unit_weight_kg_per_m(main_dia_mm)
    main_cnt = math.ceil(slab_length_mm / main_spacing_mm) + 1
    main_cut_len = (slab_width_mm + 2 * dev_len_mm) / 1000
    main_w = main_cut_len * main_cnt * unit_main

    unit_dist = steel_unit_weight_kg_per_m(dist_dia_mm)
    dist_cnt = math.ceil(slab_width_mm / dist_spacing_mm) + 1
    dist_cut_len = (slab_length_mm + 2 * dev_len_mm) / 1000
    dist_w = dist_cut_len * dist_cnt * unit_dist

    net = main_w + dist_w
    tot = net * (1 + wastage_pct / 100)
    return {
        "mainWeightKg": main_w,
        "distWeightKg": dist_w,
        "totalWeightKg": tot,
        "cost": tot * price_per_kg if price_per_kg > 0 else 0,
        "mainCount": main_cnt,
        "distCount": dist_cnt,
    }


def calc_two_way_slab_frontend(
    lx_mm: float,
    ly_mm: float,
    x_dia_mm: float,
    x_spacing_mm: float,
    y_dia_mm: float,
    y_spacing_mm: float,
    dev_len_mm: float,
    wastage_pct: float = 5.0,
    price_per_kg: float = 0,
):
    unit_x = steel_unit_weight_kg_per_m(x_dia_mm)
    x_cnt = math.ceil(ly_mm / x_spacing_mm) + 1
    x_cut_len = (lx_mm + 2 * dev_len_mm) / 1000
    x_w = unit_x * x_cut_len * x_cnt

    unit_y = steel_unit_weight_kg_per_m(y_dia_mm)
    y_cnt = math.ceil(lx_mm / y_spacing_mm) + 1
    y_cut_len = (ly_mm + 2 * dev_len_mm) / 1000
    y_w = unit_y * y_cut_len * y_cnt

    net = x_w + y_w
    tot = net * (1 + wastage_pct / 100)
    return {
        "xWeightKg": x_w,
        "yWeightKg": y_w,
        "totalWeightKg": tot,
        "cost": tot * price_per_kg if price_per_kg > 0 else 0,
        "xCount": x_cnt,
        "yCount": y_cnt,
    }


# Concrete

def calc_concrete_backend(
    wet_volume: float,
    wastage_pct: float = 5.0,
    grade: str = "M20",
    stairs_steps: int = 0,
    stairs_width: float = 0.0,
    stairs_riser: float = 0.0,
    stairs_tread: float = 0.0,
    stairs_waist: float = 0.0,
):
    if stairs_steps > 0:
        steps_vol = stairs_steps * stairs_width * ((stairs_riser * stairs_tread) / 2.0)
        waist_len = math.sqrt(stairs_riser**2 + stairs_tread**2)
        waist_vol = stairs_waist * stairs_width * waist_len * stairs_steps
        wet_volume = steps_vol + waist_vol
    dry_volume = wet_volume * CONCRETE_DRY_FACTOR * (1 + wastage_pct / 100.0)
    mix = CONCRETE_MIX_LIBRARY.get(grade)
    if mix is None:
        return {
            "wet_volume_m3": _round3(wet_volume),
            "dry_volume_m3": _round3(dry_volume),
            "engineered_design_mix_required": True,
        }
    c_parts, s_parts, a_parts = mix
    total = c_parts + s_parts + a_parts
    cement_bags = (dry_volume * (c_parts / total) * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG
    sand_m3 = dry_volume * (s_parts / total)
    aggregate_m3 = dry_volume * (a_parts / total)
    return {
        "wet_volume_m3": _round3(wet_volume),
        "dry_volume_m3": _round3(dry_volume),
        "cement_bags": _round2(cement_bags),
        "sand_m3": _round3(sand_m3),
        "aggregate_m3": _round3(aggregate_m3),
        "engineered_design_mix_required": False,
    }


def concrete_volume_m3_frontend(
    form: str,
    slab_l: float = 0,
    slab_w: float = 0,
    slab_d: float = 0,
    col_a_mm: float = 0,
    col_b_mm: float = 0,
    col_h_mm: float = 0,
    circ_dia_m: float = 0,
    circ_height_m: float = 0,
    circ_count: int = 1,
    stair_steps: int = 0,
    stair_width_m: float = 0,
    stair_riser_m: float = 0,
    stair_tread_m: float = 0,
    stair_waist_m: float = 0,
) -> float:
    if form == "column":
        return (col_a_mm / 1000) * (col_b_mm / 1000) * (col_h_mm / 1000)
    if form == "circular":
        return (math.pi / 4) * circ_dia_m * circ_dia_m * circ_height_m * circ_count
    if form == "stair":
        steps_vol = stair_steps * stair_width_m * ((stair_riser_m * stair_tread_m) / 2.0)
        waist_len = math.sqrt(stair_riser_m**2 + stair_tread_m**2)
        waist_vol = stair_waist_m * stair_width_m * waist_len * stair_steps
        return steps_vol + waist_vol
    return slab_l * slab_w * slab_d


def calc_concrete_frontend_mix(vol_m3: float, grade: str, wastage_pct: float):
    g = "M7_5" if grade == "M7.5" else grade
    factors = CONCRETE_FRONTEND_FACTORS.get(g, CONCRETE_FRONTEND_FACTORS["M20"])
    c_factor, s_factor, a_factor = factors
    c_bags = vol_m3 * c_factor * (1 + wastage_pct / 100)
    s_m3 = vol_m3 * s_factor * (1 + wastage_pct / 100)
    a_m3 = vol_m3 * a_factor * (1 + wastage_pct / 100)
    return {"volumeM3": vol_m3, "cementBags": c_bags, "sandM3": s_m3, "aggM3": a_m3}


# RMC

def calc_rmc(pour_volume: float, mixer_size: float = 6.0, wastage_pct: float = 5.0):
    total = pour_volume * (1 + wastage_pct / 100.0)
    return {"total_volume_m3": _round3(total), "mixer_loads": math.ceil(total / mixer_size)}


def rmc_net_volume_m3_frontend(
    tab: str,
    direct_vol_m3: float = 0,
    slab_l: float = 0,
    slab_w: float = 0,
    slab_t_mm: float = 0,
    col_a_mm: float = 0,
    col_b_mm: float = 0,
    col_h_m: float = 0,
    col_count: int = 0,
    beam_l_m: float = 0,
    beam_w_mm: float = 0,
    beam_d_mm: float = 0,
    beam_count: int = 0,
    foot_l_m: float = 0,
    foot_w_m: float = 0,
    foot_d_m: float = 0,
    foot_count: int = 0,
) -> float:
    if tab == "slab":
        return slab_l * slab_w * (slab_t_mm / 1000)
    if tab == "column":
        return (col_a_mm / 1000) * (col_b_mm / 1000) * col_h_m * col_count
    if tab == "beam":
        return beam_l_m * (beam_w_mm / 1000) * (beam_d_mm / 1000) * beam_count
    if tab == "footing":
        return foot_l_m * foot_w_m * foot_d_m * foot_count
    return direct_vol_m3


# Brick

def brick_leaves_from_thickness(thickness_mm: float, brick_width_mm: float, joint_mm: float) -> int:
    return max(1, round(thickness_mm / (brick_width_mm + joint_mm)))


def calc_brick_backend(
    length_m: float,
    height_m: float,
    thickness_mm: float,
    brick_length_mm: float = 190.0,
    brick_width_mm: float = 90.0,
    brick_height_mm: float = 90.0,
    joint_mm: float = 10.0,
    wastage_pct: float = 10.0,
):
    leaves = brick_leaves_from_thickness(thickness_mm, brick_width_mm, joint_mm)
    b_len = (brick_length_mm + joint_mm) / 1000.0
    b_hgt = (brick_height_mm + joint_mm) / 1000.0
    wall_area = length_m * height_m
    face_area = b_len * b_hgt
    bricks_needed = (wall_area / face_area) * leaves * (1 + wastage_pct / 100.0)
    wall_volume = length_m * height_m * (thickness_mm / 1000.0)
    brick_vol_actual = (brick_length_mm / 1000.0) * (brick_width_mm / 1000.0) * (brick_height_mm / 1000.0)
    net_bricks_no_waste = (wall_area / face_area) * leaves
    mortar_volume = wall_volume - net_bricks_no_waste * brick_vol_actual
    dry_mortar_vol = mortar_volume * 1.33
    cement_m3 = dry_mortar_vol * (1.0 / 7.0)
    cement_bags = (cement_m3 * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG
    sand_m3 = dry_mortar_vol * (6.0 / 7.0)
    return {
        "wall_area_m2": _round2(wall_area),
        "wall_volume_m3": _round3(wall_volume),
        "leaves": leaves,
        "bricks_needed": math.ceil(bricks_needed),
        "mortar_volume_m3": _round3(mortar_volume),
        "cement_bags": _round2(cement_bags),
        "sand_m3": _round3(sand_m3),
    }


def brick_mortar_share_ok(mortar_volume_m3: float, wall_volume_m3: float) -> bool:
    if wall_volume_m3 <= 0:
        return False
    share = mortar_volume_m3 / wall_volume_m3
    return 0.20 <= share <= 0.35


# Paint

def calc_paint(
    room_length_ft: float,
    room_width_ft: float,
    ceiling_height_ft: float,
    paint_ceiling: bool,
    doors_count: int,
    windows_count: int,
    coats: int,
    quality: str,
):
    total_wall_area = 2 * (room_length_ft + room_width_ft) * ceiling_height_ft
    if paint_ceiling:
        total_wall_area += room_length_ft * room_width_ft
    paintable_area = total_wall_area - doors_count * PAINT_DOOR_AREA_SQFT - windows_count * PAINT_WINDOW_AREA_SQFT
    if paintable_area <= 0:
        raise ValueError("Total opening area exceeds the wall area")
    coverage = PAINT_COVERAGE_SQFT_PER_LITRE.get(quality.lower(), 135.0)
    paint_litres = (paintable_area / coverage) * coats * PAINT_WASTAGE_FACTOR
    putty_kg = (paintable_area / 100.0) * PUTTY_KG_PER_SQFT_FACTOR * PUTTY_WASTAGE
    primer_litres = (paintable_area / PRIMER_DIVISOR) * PRIMER_WASTAGE
    return {
        "paintable_area_sqft": _round2(paintable_area),
        "paint_litres": _round2(paint_litres),
        "putty_kg": _round2(putty_kg),
        "primer_litres": _round2(primer_litres),
    }


# Tile

def calc_tile(
    length_ft: float,
    width_ft: float,
    tile_length_inch: float,
    tile_width_inch: float,
    grout_mm: float,
    wastage_pct: float,
):
    room_area = length_ft * width_ft
    grout_inch = grout_mm / 25.4
    tile_len_ft = (tile_length_inch + grout_inch) / 12.0
    tile_wid_ft = (tile_width_inch + grout_inch) / 12.0
    single_tile_area = tile_len_ft * tile_wid_ft
    tiles_needed = (room_area / single_tile_area) * (1 + wastage_pct / 100.0)
    return {"room_area_sqft": _round2(room_area), "tiles_needed": math.ceil(tiles_needed)}


# Plaster

def calc_plaster(wall_area_m2: float, thickness_mm: float, mix_ratio: str, wastage_pct: float):
    thick_m = thickness_mm / 1000.0
    wet_volume = wall_area_m2 * thick_m
    dry_volume = wet_volume * PLASTER_DRY_FACTOR * (1 + wastage_pct / 100.0)
    parts = mix_ratio.split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid mix_ratio '{mix_ratio}'. Expected format 'cement:sand', e.g. '1:4' or '1:6'.")
    try:
        c_parts = float(parts[0])
        s_parts = float(parts[1])
    except ValueError:
        raise ValueError(f"mix_ratio parts must be numeric, got '{mix_ratio}'.")
    if c_parts <= 0 or s_parts <= 0:
        raise ValueError("mix_ratio parts must both be positive numbers.")
    total = c_parts + s_parts
    cement_m3 = dry_volume * (c_parts / total)
    cement_bags = (cement_m3 * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG
    sand_m3 = dry_volume * (s_parts / total)
    return {
        "wet_volume_m3": round(wet_volume, 4),
        "dry_volume_m3": round(dry_volume, 4),
        "cement_bags": _round2(cement_bags),
        "sand_m3": _round3(sand_m3),
    }


# Waterproofing

def calc_waterproofing(area_sqft: float, coverage_sqft_per_litre: float, coats: int, wastage_pct: float):
    litres = (area_sqft / coverage_sqft_per_litre) * coats * (1 + wastage_pct / 100.0)
    return {"litres_needed": _round2(litres)}


# House Cost

def calc_house_cost(
    area_sqft: float,
    base_rate: float,
    floors: int,
    is_commercial: bool = False,
    compound_wall_length_ft: float = 0.0,
    contingency_pct: float = 12.0,
):
    total_construction_cost = 0.0
    for f in range(floors):
        multiplier = 1.0 + 0.12 * f
        total_construction_cost += area_sqft * (base_rate * multiplier)
    if is_commercial:
        total_construction_cost *= 1.10
    compound_wall_cost = compound_wall_length_ft * (base_rate * 0.35)
    total_project_cost = total_construction_cost + compound_wall_cost
    structure = total_project_cost * 0.40
    finishing = total_project_cost * 0.25
    mep = total_project_cost * 0.15
    interior = total_project_cost * 0.12
    misc = total_project_cost * 0.08
    contingency_buffer = total_project_cost * (contingency_pct / 100.0)
    return {
        "base_construction_cost": _round2(total_construction_cost),
        "compound_wall_cost": _round2(compound_wall_cost),
        "total_project_cost": _round2(total_project_cost),
        "splits": {
            "structure": _round2(structure),
            "finishing": _round2(finishing),
            "mep": _round2(mep),
            "interior": _round2(interior),
            "misc": _round2(misc),
        },
        "contingency_buffer": _round2(contingency_buffer),
    }


# Billing

def calc_billing(subtotal: float, gst_pct: float, deductions: List[Dict], retentions: List[Dict], pre_tax_deductions: bool):
    ded_amt = 0.0
    ret_amt = 0.0
    if pre_tax_deductions:
        for d in deductions:
            t = d.get("type")
            v = d.get("val", 0)
            if t in ("pct_item_subtotal", "pct_total"):
                ded_amt += subtotal * (v / 100.0)
            else:
                ded_amt += v
        for r in retentions:
            if r.get("type") == "pct":
                ret_amt += subtotal * (r.get("val", 0) / 100.0)
            else:
                ret_amt += r.get("val", 0)
        taxable = subtotal - ded_amt - ret_amt
        gst_amount = taxable * (gst_pct / 100.0)
        net_payable = taxable + gst_amount
    else:
        gst_amount = subtotal * (gst_pct / 100.0)
        total_amount = subtotal + gst_amount
        for d in deductions:
            t = d.get("type")
            v = d.get("val", 0)
            if t == "pct_item_subtotal":
                ded_amt += subtotal * (v / 100.0)
            elif t == "pct_total":
                ded_amt += total_amount * (v / 100.0)
            else:
                ded_amt += v
        for r in retentions:
            if r.get("type") == "pct":
                ret_amt += total_amount * (r.get("val", 0) / 100.0)
            else:
                ret_amt += r.get("val", 0)
        net_payable = total_amount - ded_amt - ret_amt
    return {
        "subtotal": _round2(subtotal),
        "gst_amount": _round2(gst_amount),
        "total_deductions": _round2(ded_amt),
        "total_retention": _round2(ret_amt),
        "net_payable": _round2(net_payable),
    }


# Split Rate

def calc_split_rate(quantity: float, supply_rate: float, installation_rate: float, supply_tax_pct: float, installation_tax_pct: float, is_item_tax: bool):
    gross_supply = quantity * supply_rate
    gross_installation = quantity * installation_rate
    gross_combined = gross_supply + gross_installation
    if is_item_tax:
        supply_tax = gross_supply * (supply_tax_pct / 100.0)
        installation_tax = gross_installation * (installation_tax_pct / 100.0)
        total_tax = supply_tax + installation_tax
        total_amount = gross_combined + total_tax
        return {
            "gross_supply": _round2(gross_supply),
            "gross_installation": _round2(gross_installation),
            "gross_combined": _round2(gross_combined),
            "supply_tax": _round2(supply_tax),
            "installation_tax": _round2(installation_tax),
            "total_tax": _round2(total_tax),
            "total_amount": _round2(total_amount),
        }
    total_tax = gross_combined * 0.18
    total_amount = gross_combined + total_tax
    return {
        "gross_supply": _round2(gross_supply),
        "gross_installation": _round2(gross_installation),
        "gross_combined": _round2(gross_combined),
        "supply_tax": _round2(0),
        "installation_tax": _round2(0),
        "total_tax": _round2(total_tax),
        "total_amount": _round2(total_amount),
    }

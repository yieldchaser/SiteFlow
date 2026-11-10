/**
 * calc-shared.ts  -  single source of truth for construction quantity calculators.
 *
 * CD-2 (R2-010) decision: one shared module consumed by both console and API.
 * Site engineers run these on patchy mobile data  -  client computes locally,
 * no round-trip. The contract test in tests/calculators-contract.test.ts
 * pins fixed inputs to expected outputs to prevent drift (R2-521: 162.89 vs 162.0).
 *
 * All functions are pure, no I/O, no React, no fetch.
 */

// ---------------------------------------------------------------------------
// Steel  -  D^2 / 162 (IS 1786 / CPWD)
// ---------------------------------------------------------------------------
export const STEEL_DIVISOR = 162.0;

export function steelUnitWeightKgPerM(diaMm: number): number {
  return (diaMm * diaMm) / STEEL_DIVISOR;
}

export interface SteelColumnBackendInput {
  diameter: number;
  count: number;
  lengthOrHeightM: number;
  slabThicknessM?: number;
  isColumn?: boolean;
  spacingM?: number;
  spanM?: number;
  hookLengthFactor?: number;
  bendDeductionFactor?: number;
  coverM?: number;
  mainWidthM?: number;
  mainHeightM?: number;
  wastagePct?: number;
}

export interface SteelBackendResultColumn {
  unit_weight_kg_m: number;
  total_weight_kg: number;
  total_length_m: number;
}
export interface SteelBackendResultSlab {
  unit_weight_kg_m: number;
  bar_count: number;
  total_weight_kg: number;
}
export interface SteelBackendResultStirrup {
  unit_weight_kg_m: number;
  cutting_length_m: number;
  total_weight_kg: number;
}

export function calcSteelBackend(
  req: SteelColumnBackendInput
): SteelBackendResultColumn | SteelBackendResultSlab | SteelBackendResultStirrup {
  const unitWeight = steelUnitWeightKgPerM(req.diameter);
  const wastage = req.wastagePct ?? 5.0;
  if (req.isColumn) {
    const lapLength = 50 * (req.diameter / 1000.0);
    const totalLength = req.lengthOrHeightM + (req.slabThicknessM ?? 0) + lapLength;
    const totalWeight = req.count * totalLength * unitWeight * (1 + wastage / 100.0);
    return {
      unit_weight_kg_m: round4(unitWeight),
      total_weight_kg: round2(totalWeight),
      total_length_m: round2(totalLength),
    };
  }
  if ((req.spacingM ?? 0) > 0 && (req.spanM ?? 0) > 0) {
    const barCount = Math.floor(req.spanM! / req.spacingM!) + 1;
    const totalLength = req.lengthOrHeightM;
    const totalWeight = barCount * totalLength * unitWeight * (1 + wastage / 100.0);
    return {
      unit_weight_kg_m: round4(unitWeight),
      bar_count: barCount,
      total_weight_kg: round2(totalWeight),
    };
  }
  const cover = req.coverM ?? 0.04;
  const mainWidth = req.mainWidthM ?? 0.3;
  const mainHeight = req.mainHeightM ?? 0.4;
  const hookFactor = req.hookLengthFactor ?? 9;
  const bendFactor = req.bendDeductionFactor ?? 2;
  const a = mainWidth - 2 * cover;
  const b = mainHeight - 2 * cover;
  const hookLen = hookFactor * (req.diameter / 1000.0);
  const bendDed = bendFactor * (req.diameter / 1000.0);
  const cuttingLength = 2 * (a + b) + 2 * hookLen - 2 * bendDed;
  const totalWeight = req.count * cuttingLength * unitWeight * (1 + wastage / 100.0);
  return {
    unit_weight_kg_m: round4(unitWeight),
    cutting_length_m: round4(cuttingLength),
    total_weight_kg: round2(totalWeight),
  };
}

// Frontend enhanced steel  -  column with dual-zone stirrups and secondary bar
export interface SteelColumnFrontendInput {
  colHeightMm: number;
  slabThickMm: number;
  sizeAMm: number;
  sizeBMm: number;
  mainBarDiaMm: number;
  mainBarCount: number;
  stirrupDiaMm: number;
  stirrupSpacingMm: number;
  colBar2DiaMm?: number;
  colBar2Count?: number;
  colSpEndMm?: number;
  colSpMidMm?: number;
  wastagePct?: number;
  pricePerKg?: number;
  // aliases kept for drift-safe callers
  steelWastagePct?: number;
  steelPricePerKg?: number;
}

export interface SteelColumnFrontendResult {
  bar1WeightKg: number;
  bar2WeightKg: number;
  stirrupWeightKg: number;
  totalWeightKg: number;
  cost: number;
  stirEndCount: number;
  stirMidCount: number;
  stirrupCount: number;
}

export function calcSteelColumnFrontend(inp: SteelColumnFrontendInput): SteelColumnFrontendResult {
  const wastage = inp.wastagePct ?? inp.steelWastagePct ?? 5;
  const price = inp.pricePerKg ?? inp.steelPricePerKg ?? 0;
  const unitW1 = steelUnitWeightKgPerM(inp.mainBarDiaMm);
  const hM = inp.colHeightMm / 1000;
  const slabM = inp.slabThickMm / 1000;
  const lapM = (50 * inp.mainBarDiaMm) / 1000;
  const bar1Len = (hM + slabM + lapM) * inp.mainBarCount;
  const bar1W = bar1Len * unitW1;

  const bar2Dia = inp.colBar2DiaMm ?? 0;
  const bar2Count = inp.colBar2Count ?? 0;
  let bar2W = 0;
  if (bar2Dia > 0 && bar2Count > 0) {
    const unitW2 = steelUnitWeightKgPerM(bar2Dia);
    const lap2 = (50 * bar2Dia) / 1000;
    const len2 = (hM + slabM + lap2) * bar2Count;
    bar2W = len2 * unitW2;
  }

  const stirUnitW = steelUnitWeightKgPerM(inp.stirrupDiaMm);
  const stirLen = (2 * ((inp.sizeAMm - 80) + (inp.sizeBMm - 80)) + 6 * inp.stirrupDiaMm) / 1000;
  const lo = Math.max(inp.colHeightMm / 6, Math.max(inp.sizeAMm, inp.sizeBMm), 450);
  const spEnd = inp.colSpEndMm || inp.stirrupSpacingMm;
  const spMid = inp.colSpMidMm || inp.stirrupSpacingMm;
  const endCount = Math.ceil(lo / spEnd) + 1;
  const midCount = Math.max(0, Math.floor((inp.colHeightMm - 2 * lo) / spMid) - 1);
  const totalStirrups = 2 * endCount + midCount;
  const stirW = stirLen * totalStirrups * stirUnitW;

  const netW = bar1W + bar2W + stirW;
  const totW = netW * (1 + wastage / 100);
  const cost = price > 0 ? totW * price : 0;
  return {
    bar1WeightKg: bar1W,
    bar2WeightKg: bar2W,
    stirrupWeightKg: stirW,
    totalWeightKg: totW,
    cost,
    stirEndCount: endCount,
    stirMidCount: midCount,
    stirrupCount: totalStirrups,
  };
}

export interface SlabSteelFrontendInput {
  slabLengthMm: number;
  slabWidthMm: number;
  mainDiaMm: number;
  mainSpacingMm: number;
  distDiaMm: number;
  distSpacingMm: number;
  devLenMm: number;
  wastagePct?: number;
  pricePerKg?: number;
}

export interface SlabSteelFrontendResult {
  mainWeightKg: number;
  distWeightKg: number;
  totalWeightKg: number;
  cost: number;
  mainCount: number;
  distCount: number;
}

export function calcSlabSteelFrontend(inp: SlabSteelFrontendInput): SlabSteelFrontendResult {
  const wastage = inp.wastagePct ?? 5;
  const price = inp.pricePerKg ?? 0;
  const unitMain = steelUnitWeightKgPerM(inp.mainDiaMm);
  const mainCnt = Math.ceil(inp.slabLengthMm / inp.mainSpacingMm) + 1;
  const mainCutLen = (inp.slabWidthMm + 2 * inp.devLenMm) / 1000;
  const mainW = mainCutLen * mainCnt * unitMain;

  const unitDist = steelUnitWeightKgPerM(inp.distDiaMm);
  const distCnt = Math.ceil(inp.slabWidthMm / inp.distSpacingMm) + 1;
  const distCutLen = (inp.slabLengthMm + 2 * inp.devLenMm) / 1000;
  const distW = distCutLen * distCnt * unitDist;

  const net = mainW + distW;
  const tot = net * (1 + wastage / 100);
  return {
    mainWeightKg: mainW,
    distWeightKg: distW,
    totalWeightKg: tot,
    cost: price > 0 ? tot * price : 0,
    mainCount: mainCnt,
    distCount: distCnt,
  };
}

export interface TwoWaySlabInput {
  lxMm: number;
  lyMm: number;
  xDiaMm: number;
  xSpacingMm: number;
  yDiaMm: number;
  ySpacingMm: number;
  devLenMm: number;
  wastagePct?: number;
  pricePerKg?: number;
}

export interface TwoWaySlabResult {
  xWeightKg: number;
  yWeightKg: number;
  totalWeightKg: number;
  cost: number;
  xCount: number;
  yCount: number;
}

export function calcTwoWaySlabFrontend(inp: TwoWaySlabInput): TwoWaySlabResult {
  const wastage = inp.wastagePct ?? 5;
  const price = inp.pricePerKg ?? 0;
  const unitX = steelUnitWeightKgPerM(inp.xDiaMm);
  const xCnt = Math.ceil(inp.lyMm / inp.xSpacingMm) + 1;
  const xCutLen = (inp.lxMm + 2 * inp.devLenMm) / 1000;
  const xW = unitX * xCutLen * xCnt;

  const unitY = steelUnitWeightKgPerM(inp.yDiaMm);
  const yCnt = Math.ceil(inp.lxMm / inp.ySpacingMm) + 1;
  const yCutLen = (inp.lyMm + 2 * inp.devLenMm) / 1000;
  const yW = unitY * yCutLen * yCnt;

  const net = xW + yW;
  const tot = net * (1 + wastage / 100);
  return {
    xWeightKg: xW,
    yWeightKg: yW,
    totalWeightKg: tot,
    cost: price > 0 ? tot * price : 0,
    xCount: xCnt,
    yCount: yCnt,
  };
}

// ---------------------------------------------------------------------------
// Concrete  -  1.54 dry factor, mix library
// ---------------------------------------------------------------------------
export const CONCRETE_DRY_FACTOR = 1.54;
export const CEMENT_DENSITY_KG_M3 = 1440;
export const CEMENT_BAG_KG = 50;

export type ConcreteGrade = "M5" | "M7.5" | "M10" | "M15" | "M20" | "M25" | "M30" | "M35" | "M40" | "M45";

export const CONCRETE_MIX_LIBRARY: Record<string, [number, number, number]> = {
  // cement : sand : aggregate parts (backend canonical)
  "M7.5": [1.0, 4.0, 8.0],
  M10: [1.0, 3.0, 6.0],
  M15: [1.0, 2.0, 4.0],
  M20: [1.0, 1.5, 3.0],
  M25: [1.0, 1.0, 2.0],
};

// Frontend precomputed cement bags/m3 factors derived from CONCRETE_MIX_LIBRARY + 1.54 factor
// cementBagsPerM3 = (1.54 / sum) * 1440/50, sandPerM3 = 1.54 * sandParts / sum, etc.
// Verified: M20 1:1.5:3 sum 5.5 -> 1.54/5.5*28.8 = 8.06, matches frontend table.
export const CONCRETE_FRONTEND_FACTORS: Record<string, [number, number, number]> = {
  M5: [2.77, 0.48, 0.96],
  M7_5: [3.41, 0.47, 0.94],
  M10: [4.4, 0.46, 0.92],
  M15: [6.3, 0.44, 0.88],
  M20: [8.06, 0.42, 0.84],
  M25: [11.1, 0.38, 0.77],
};

export interface ConcreteBackendInput {
  wetVolumeM3: number;
  wastagePct?: number;
  grade?: string;
  stairsSteps?: number;
  stairsWidthM?: number;
  stairsRiserM?: number;
  stairsTreadM?: number;
  stairsWaistM?: number;
}

export interface ConcreteBackendResult {
  wet_volume_m3: number;
  dry_volume_m3: number;
  cement_bags?: number;
  sand_m3?: number;
  aggregate_m3?: number;
  engineered_design_mix_required: boolean;
}

export function calcConcreteBackend(inp: ConcreteBackendInput): ConcreteBackendResult {
  let wetVolume = inp.wetVolumeM3;
  const steps = inp.stairsSteps ?? 0;
  if (steps > 0) {
    const w = inp.stairsWidthM ?? 0;
    const riser = inp.stairsRiserM ?? 0;
    const tread = inp.stairsTreadM ?? 0;
    const waist = inp.stairsWaistM ?? 0;
    const stepsVol = steps * w * ((riser * tread) / 2.0);
    const waistLen = Math.sqrt(riser * riser + tread * tread);
    const waistVol = waist * w * waistLen * steps;
    wetVolume = stepsVol + waistVol;
  }
  const wastage = inp.wastagePct ?? 5.0;
  const dryVolume = wetVolume * CONCRETE_DRY_FACTOR * (1 + wastage / 100.0);
  const grade = inp.grade ?? "M20";
  const mix = CONCRETE_MIX_LIBRARY[grade];
  if (!mix) {
    return {
      wet_volume_m3: round3(wetVolume),
      dry_volume_m3: round3(dryVolume),
      engineered_design_mix_required: true,
    };
  }
  const [cParts, sParts, aParts] = mix;
  const total = cParts + sParts + aParts;
  const cementBags = (dryVolume * (cParts / total) * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG;
  const sandM3 = dryVolume * (sParts / total);
  const aggM3 = dryVolume * (aParts / total);
  return {
    wet_volume_m3: round3(wetVolume),
    dry_volume_m3: round3(dryVolume),
    cement_bags: round2(cementBags),
    sand_m3: round3(sandM3),
    aggregate_m3: round3(aggM3),
    engineered_design_mix_required: false,
  };
}

export interface ConcreteFrontendVolInput {
  form: "slab" | "column" | "circular" | "footing" | "stair";
  slabL?: number;
  slabW?: number;
  slabD?: number;
  colAmm?: number;
  colBmm?: number;
  colHmm?: number;
  circDiaM?: number;
  circHeightM?: number;
  circCount?: number;
  stairSteps?: number;
  stairWidthM?: number;
  stairRiserM?: number;
  stairTreadM?: number;
  stairWaistM?: number;
}

export function concreteVolumeM3(inp: ConcreteFrontendVolInput): number {
  if (inp.form === "column") {
    return ((inp.colAmm ?? 0) / 1000) * ((inp.colBmm ?? 0) / 1000) * ((inp.colHmm ?? 0) / 1000);
  }
  if (inp.form === "circular") {
    const d = inp.circDiaM ?? 0;
    const h = inp.circHeightM ?? 0;
    const c = inp.circCount ?? 1;
    return (Math.PI / 4) * d * d * h * c;
  }
  if (inp.form === "stair") {
    const steps = inp.stairSteps ?? 0;
    const w = inp.stairWidthM ?? 0;
    const riser = inp.stairRiserM ?? 0;
    const tread = inp.stairTreadM ?? 0;
    const waist = inp.stairWaistM ?? 0;
    const stepsVol = steps * w * ((riser * tread) / 2.0);
    const waistLen = Math.sqrt(riser * riser + tread * tread);
    const waistVol = waist * w * waistLen * steps;
    return stepsVol + waistVol;
  }
  return (inp.slabL ?? 0) * (inp.slabW ?? 0) * (inp.slabD ?? 0);
}

export interface ConcreteFrontendMixResult {
  volumeM3: number;
  cementBags: number;
  sandM3: number;
  aggM3: number;
}

export function calcConcreteFrontendMix(
  volM3: number,
  grade: string,
  wastagePct: number
): ConcreteFrontendMixResult {
  // Normalize M7.5 alias
  const g = grade === "M7.5" ? "M7_5" : grade;
  const factors = CONCRETE_FRONTEND_FACTORS[g] ?? CONCRETE_FRONTEND_FACTORS.M20;
  const [cFactor, sFactor, aFactor] = factors;
  const cBags = volM3 * cFactor * (1 + wastagePct / 100);
  const sM3 = volM3 * sFactor * (1 + wastagePct / 100);
  const aM3 = volM3 * aFactor * (1 + wastagePct / 100);
  return { volumeM3: volM3, cementBags: cBags, sandM3: sM3, aggM3: aM3 };
}

// ---------------------------------------------------------------------------
// RMC
// ---------------------------------------------------------------------------
export interface RmcInput {
  pourVolumeM3: number;
  mixerSizeM3?: number;
  wastagePct?: number;
}

export interface RmcResult {
  totalVolumeM3: number;
  mixerLoads: number;
}

export function calcRmc(inp: RmcInput): RmcResult {
  const mixer = inp.mixerSizeM3 ?? 6.0;
  const wastage = inp.wastagePct ?? 5.0;
  const total = inp.pourVolumeM3 * (1 + wastage / 100.0);
  return { totalVolumeM3: round3(total), mixerLoads: Math.ceil(total / mixer) };
}

export interface RmcFrontendNetInput {
  tab: "direct" | "slab" | "column" | "beam" | "footing";
  directVolM3?: number;
  slabL?: number;
  slabW?: number;
  slabTMm?: number;
  colAMm?: number;
  colBMm?: number;
  colHM?: number;
  colCount?: number;
  beamLM?: number;
  beamWMm?: number;
  beamDMm?: number;
  beamCount?: number;
  footLM?: number;
  footWM?: number;
  footDM?: number;
  footCount?: number;
}

export function rmcNetVolumeM3(inp: RmcFrontendNetInput): number {
  if (inp.tab === "slab") return (inp.slabL ?? 0) * (inp.slabW ?? 0) * ((inp.slabTMm ?? 0) / 1000);
  if (inp.tab === "column")
    return ((inp.colAMm ?? 0) / 1000) * ((inp.colBMm ?? 0) / 1000) * (inp.colHM ?? 0) * (inp.colCount ?? 0);
  if (inp.tab === "beam")
    return (inp.beamLM ?? 0) * ((inp.beamWMm ?? 0) / 1000) * ((inp.beamDMm ?? 0) / 1000) * (inp.beamCount ?? 0);
  if (inp.tab === "footing")
    return (inp.footLM ?? 0) * (inp.footWM ?? 0) * (inp.footDM ?? 0) * (inp.footCount ?? 0);
  return inp.directVolM3 ?? 0;
}

// ---------------------------------------------------------------------------
// Brick & Mortar
// ---------------------------------------------------------------------------
export const BRICK_PRESETS: Record<string, [number, number, number]> = {
  modular: [190, 90, 90],
  traditional: [230, 110, 75],
  uk: [215, 102, 65],
  us: [203, 92, 95],
};

export function brickLeavesFromThickness(thicknessMm: number, brickWidthMm: number, jointMm: number): number {
  return Math.max(1, Math.round(thicknessMm / (brickWidthMm + jointMm)));
}

export interface BrickBackendInput {
  lengthM: number;
  heightM: number;
  thicknessMm: number;
  brickLengthMm?: number;
  brickWidthMm?: number;
  brickHeightMm?: number;
  jointMm?: number;
  wastagePct?: number;
}

export interface BrickResult {
  wallAreaM2: number;
  wallVolumeM3: number;
  leaves: number;
  bricksNeeded: number;
  mortarVolumeM3: number;
  cementBags: number;
  sandM3: number;
}

export function calcBrickBackend(inp: BrickBackendInput): BrickResult {
  const bLenMm = inp.brickLengthMm ?? 190.0;
  const bWidthMm = inp.brickWidthMm ?? 90.0;
  const bHeightMm = inp.brickHeightMm ?? 90.0;
  const jointMm = inp.jointMm ?? 10.0;
  const wastage = inp.wastagePct ?? 10.0;

  const leaves = brickLeavesFromThickness(inp.thicknessMm, bWidthMm, jointMm);
  const bLen = (bLenMm + jointMm) / 1000.0;
  const bHgt = (bHeightMm + jointMm) / 1000.0;
  const wallArea = inp.lengthM * inp.heightM;
  const faceArea = bLen * bHgt;
  const bricksNeeded = (wallArea / faceArea) * leaves * (1 + wastage / 100.0);

  const wallVolume = inp.lengthM * inp.heightM * (inp.thicknessMm / 1000.0);
  const brickVolActual = (bLenMm / 1000.0) * (bWidthMm / 1000.0) * (bHeightMm / 1000.0);
  const netBricksNoWaste = (wallArea / faceArea) * leaves;
  const mortarVolume = wallVolume - netBricksNoWaste * brickVolActual;

  const dryMortarVol = mortarVolume * 1.33;
  const cementM3 = dryMortarVol * (1.0 / 7.0);
  const cementBags = (cementM3 * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG;
  const sandM3 = dryMortarVol * (6.0 / 7.0);

  return {
    wallAreaM2: round2(wallArea),
    wallVolumeM3: round3(wallVolume),
    leaves,
    bricksNeeded: Math.ceil(bricksNeeded),
    mortarVolumeM3: round3(mortarVolume),
    cementBags: round2(cementBags),
    sandM3: round3(sandM3),
  };
}

export function brickMortarShareOk(mortarVolumeM3: number, wallVolumeM3: number): boolean {
  if (wallVolumeM3 <= 0) return false;
  const share = mortarVolumeM3 / wallVolumeM3;
  return share >= 0.2 && share <= 0.35;
}

export interface BrickFrontendInput {
  wallLM: number;
  wallHM: number;
  preset: string;
  mortarJointMm: number;
  leaves: 1 | 2;
  wastagePct: number;
  mortarRatio: string;
}

export interface BrickFrontendResult {
  bricksNeeded: number;
  cementBags: number;
  sandM3: number;
}

export function calcBrickFrontend(inp: BrickFrontendInput): BrickFrontendResult {
  const preset = BRICK_PRESETS[inp.preset] ?? BRICK_PRESETS.modular;
  const [bLen, bW, bH] = preset;
  const bFaceArea = ((bLen + inp.mortarJointMm) / 1000.0) * ((bH + inp.mortarJointMm) / 1000.0);
  const wallArea = inp.wallLM * inp.wallHM;
  const bNeeded = Math.ceil((wallArea / bFaceArea) * inp.leaves * (1 + inp.wastagePct / 100));
  const wallThkMm = inp.leaves === 2 ? 2 * bW + inp.mortarJointMm : bW + inp.mortarJointMm;
  const wallVol = wallArea * (wallThkMm / 1000.0);
  const actualVol = (bLen / 1000.0) * (bW / 1000.0) * (bH / 1000.0);
  const netBricksNoWaste = (wallArea / bFaceArea) * inp.leaves;
  const mortarVol = Math.max(0, wallVol - netBricksNoWaste * actualVol);
  const dryMortarVol = mortarVol * 1.33;
  const parts = inp.mortarRatio.split(":");
  const cParts = parseFloat(parts[0]) || 1.0;
  const sParts = parseFloat(parts[1]) || 6.0;
  const totalParts = cParts + sParts;
  const cBags = ((dryMortarVol * (cParts / totalParts)) * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG;
  const sM3 = dryMortarVol * (sParts / totalParts);
  return { bricksNeeded: bNeeded, cementBags: cBags, sandM3: sM3 };
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------
export const PAINT_DOOR_AREA_SQFT = 21.0;
export const PAINT_WINDOW_AREA_SQFT = 12.0;
export const PAINT_COVERAGE_SQFT_PER_LITRE: Record<string, number> = {
  economy: 115.0,
  premium: 135.0,
  luxury: 155.0,
  texture: 80.0,
};
export const PAINT_WASTAGE_FACTOR = 1.1;
// kg per 100 sq ft for two coats on smooth plaster (Birla White: 1.5-2.0 sq m/kg,
// about 18 sq ft/kg). It was 2.25, less than half what the maker quotes.
export const PUTTY_KG_PER_SQFT_FACTOR = 5.5;
export const PUTTY_WASTAGE = 1.1;
export const PRIMER_DIVISOR = 175.0;
export const PRIMER_WASTAGE = 1.05;

export interface PaintInput {
  roomLengthFt: number;
  roomWidthFt: number;
  ceilingHeightFt: number;
  paintCeiling: boolean;
  doorsCount: number;
  windowsCount: number;
  coats: number;
  quality: string;
}

export interface PaintResult {
  paintableAreaSqft: number;
  paintLitres: number;
  puttyKg: number;
  primerLitres: number;
}

export function calcPaint(inp: PaintInput): PaintResult {
  let totalWallArea = 2 * (inp.roomLengthFt + inp.roomWidthFt) * inp.ceilingHeightFt;
  if (inp.paintCeiling) totalWallArea += inp.roomLengthFt * inp.roomWidthFt;
  const paintableArea = totalWallArea - inp.doorsCount * PAINT_DOOR_AREA_SQFT - inp.windowsCount * PAINT_WINDOW_AREA_SQFT;
  if (paintableArea <= 0) throw new Error("Total opening area exceeds the wall area");
  const coverage = PAINT_COVERAGE_SQFT_PER_LITRE[inp.quality.toLowerCase()] ?? 135.0;
  const paintLitres = (paintableArea / coverage) * inp.coats * PAINT_WASTAGE_FACTOR;
  const puttyKg = (paintableArea / 100.0) * PUTTY_KG_PER_SQFT_FACTOR * PUTTY_WASTAGE;
  const primerLitres = (paintableArea / PRIMER_DIVISOR) * PRIMER_WASTAGE;
  return {
    paintableAreaSqft: round2(paintableArea),
    paintLitres: round2(paintLitres),
    puttyKg: round2(puttyKg),
    primerLitres: round2(primerLitres),
  };
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------
export interface TileInput {
  lengthFt: number;
  widthFt: number;
  tileLengthInch: number;
  tileWidthInch: number;
  groutMm: number;
  wastagePct: number;
}

export interface TileResult {
  roomAreaSqft: number;
  tilesNeeded: number;
}

export function calcTile(inp: TileInput): TileResult {
  const roomArea = inp.lengthFt * inp.widthFt;
  const groutInch = inp.groutMm / 25.4;
  const tileLenFt = (inp.tileLengthInch + groutInch) / 12.0;
  const tileWidFt = (inp.tileWidthInch + groutInch) / 12.0;
  const singleTileArea = tileLenFt * tileWidFt;
  const tilesNeeded = (roomArea / singleTileArea) * (1 + inp.wastagePct / 100.0);
  return { roomAreaSqft: round2(roomArea), tilesNeeded: Math.ceil(tilesNeeded) };
}

// ---------------------------------------------------------------------------
// Plastering
// ---------------------------------------------------------------------------
export const PLASTER_DRY_FACTOR = 1.33;

export interface PlasterInput {
  wallAreaM2: number;
  thicknessMm: number;
  mixRatio: string;
  wastagePct: number;
}

export interface PlasterResult {
  wetVolumeM3: number;
  dryVolumeM3: number;
  cementBags: number;
  sandM3: number;
}

export function calcPlaster(inp: PlasterInput): PlasterResult {
  const thickM = inp.thicknessMm / 1000.0;
  const wetVolume = inp.wallAreaM2 * thickM;
  const dryVolume = wetVolume * PLASTER_DRY_FACTOR * (1 + inp.wastagePct / 100.0);
  const parts = inp.mixRatio.split(":");
  if (parts.length !== 2) throw new Error(`Invalid mix_ratio '${inp.mixRatio}'. Expected format 'cement:sand', e.g. '1:4' or '1:6'.`);
  const cParts = parseFloat(parts[0]);
  const sParts = parseFloat(parts[1]);
  if (isNaN(cParts) || isNaN(sParts)) throw new Error(`mix_ratio parts must be numeric, got '${inp.mixRatio}'.`);
  if (cParts <= 0 || sParts <= 0) throw new Error("mix_ratio parts must both be positive numbers.");
  const total = cParts + sParts;
  const cementM3 = dryVolume * (cParts / total);
  const cementBags = (cementM3 * CEMENT_DENSITY_KG_M3) / CEMENT_BAG_KG;
  const sandM3 = dryVolume * (sParts / total);
  return {
    wetVolumeM3: round4(wetVolume),
    dryVolumeM3: round4(dryVolume),
    cementBags: round2(cementBags),
    sandM3: round3(sandM3),
  };
}

// ---------------------------------------------------------------------------
// Waterproofing
// ---------------------------------------------------------------------------
export interface WaterproofingInput {
  areaSqft: number;
  coverageSqftPerLitre: number;
  coats: number;
  wastagePct: number;
}

export interface WaterproofingResult {
  litresNeeded: number;
}

export function calcWaterproofing(inp: WaterproofingInput): WaterproofingResult {
  const litres = (inp.areaSqft / inp.coverageSqftPerLitre) * inp.coats * (1 + inp.wastagePct / 100.0);
  return { litresNeeded: round2(litres) };
}

// ---------------------------------------------------------------------------
// House Construction Cost
// ---------------------------------------------------------------------------
export interface HouseCostInput {
  areaSqft: number;
  baseRate: number;
  floors: number;
  isCommercial?: boolean;
  compoundWallLengthFt: number;
  contingencyPct: number;
}

export interface HouseCostResult {
  baseConstructionCost: number;
  compoundWallCost: number;
  totalProjectCost: number;
  splits: { structure: number; finishing: number; mep: number; interior: number; misc: number };
  contingencyBuffer: number;
}

export function calcHouseCost(inp: HouseCostInput): HouseCostResult {
  let totalConstructionCost = 0.0;
  for (let f = 0; f < inp.floors; f++) {
    const multiplier = 1.0 + 0.12 * f;
    totalConstructionCost += inp.areaSqft * (inp.baseRate * multiplier);
  }
  if (inp.isCommercial) totalConstructionCost *= 1.10;
  const compoundWallCost = inp.compoundWallLengthFt * (inp.baseRate * 0.35);
  const totalProjectCost = totalConstructionCost + compoundWallCost;
  const structure = totalProjectCost * 0.4;
  const finishing = totalProjectCost * 0.25;
  const mep = totalProjectCost * 0.15;
  const interior = totalProjectCost * 0.12;
  const misc = totalProjectCost * 0.08;
  const contingencyBuffer = totalProjectCost * (inp.contingencyPct / 100.0);
  return {
    baseConstructionCost: round2(totalConstructionCost),
    compoundWallCost: round2(compoundWallCost),
    totalProjectCost: round2(totalProjectCost),
    splits: {
      structure: round2(structure),
      finishing: round2(finishing),
      mep: round2(mep),
      interior: round2(interior),
      misc: round2(misc),
    },
    contingencyBuffer: round2(contingencyBuffer),
  };
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
export type DeductionType = "pct_item_subtotal" | "pct_total" | "lumpsum" | "pct";
export interface DeductionItem {
  type: DeductionType;
  val: number;
}
export interface BillingInput {
  subtotal: number;
  gstPct: number;
  deductions: DeductionItem[];
  retentions: DeductionItem[];
  preTaxDeductions: boolean;
}
export interface BillingResult {
  subtotal: number;
  gstAmount: number;
  totalDeductions: number;
  totalRetention: number;
  netPayable: number;
}

export function calcBilling(inp: BillingInput): BillingResult {
  let dedAmt = 0.0;
  let retAmt = 0.0;
  if (inp.preTaxDeductions) {
    for (const d of inp.deductions) {
      if (d.type === "pct_item_subtotal" || d.type === "pct_total") dedAmt += inp.subtotal * (d.val / 100.0);
      else dedAmt += d.val;
    }
    for (const r of inp.retentions) {
      if (r.type === "pct") retAmt += inp.subtotal * (r.val / 100.0);
      else retAmt += r.val;
    }
    const taxable = inp.subtotal - dedAmt - retAmt;
    const gstAmount = taxable * (inp.gstPct / 100.0);
    const netPayable = taxable + gstAmount;
    return {
      subtotal: round2(inp.subtotal),
      gstAmount: round2(gstAmount),
      totalDeductions: round2(dedAmt),
      totalRetention: round2(retAmt),
      netPayable: round2(netPayable),
    };
  }
  const gstAmount = inp.subtotal * (inp.gstPct / 100.0);
  const totalAmount = inp.subtotal + gstAmount;
  for (const d of inp.deductions) {
    if (d.type === "pct_item_subtotal") dedAmt += inp.subtotal * (d.val / 100.0);
    else if (d.type === "pct_total") dedAmt += totalAmount * (d.val / 100.0);
    else dedAmt += d.val;
  }
  for (const r of inp.retentions) {
    if (r.type === "pct") retAmt += totalAmount * (r.val / 100.0);
    else retAmt += r.val;
  }
  const netPayable = totalAmount - dedAmt - retAmt;
  return {
    subtotal: round2(inp.subtotal),
    gstAmount: round2(gstAmount),
    totalDeductions: round2(dedAmt),
    totalRetention: round2(retAmt),
    netPayable: round2(netPayable),
  };
}

// ---------------------------------------------------------------------------
// Split Rate
// ---------------------------------------------------------------------------
export interface SplitRateInput {
  quantity: number;
  supplyRate: number;
  installationRate: number;
  supplyTaxPct: number;
  installationTaxPct: number;
  isItemTax: boolean;
}
export interface SplitRateResult {
  grossSupply: number;
  grossInstallation: number;
  grossCombined: number;
  supplyTax: number;
  installationTax: number;
  totalTax: number;
  totalAmount: number;
}

export function calcSplitRate(inp: SplitRateInput): SplitRateResult {
  const grossSupply = inp.quantity * inp.supplyRate;
  const grossInstallation = inp.quantity * inp.installationRate;
  const grossCombined = grossSupply + grossInstallation;
  if (inp.isItemTax) {
    const supplyTax = grossSupply * (inp.supplyTaxPct / 100.0);
    const installationTax = grossInstallation * (inp.installationTaxPct / 100.0);
    const totalTax = supplyTax + installationTax;
    const totalAmount = grossCombined + totalTax;
    return {
      grossSupply: round2(grossSupply),
      grossInstallation: round2(grossInstallation),
      grossCombined: round2(grossCombined),
      supplyTax: round2(supplyTax),
      installationTax: round2(installationTax),
      totalTax: round2(totalTax),
      totalAmount: round2(totalAmount),
    };
  }
  const totalTax = grossCombined * 0.18;
  const totalAmount = grossCombined + totalTax;
  return {
    grossSupply: round2(grossSupply),
    grossInstallation: round2(grossInstallation),
    grossCombined: round2(grossCombined),
    supplyTax: round2(0),
    installationTax: round2(0),
    totalTax: round2(totalTax),
    totalAmount: round2(totalAmount),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

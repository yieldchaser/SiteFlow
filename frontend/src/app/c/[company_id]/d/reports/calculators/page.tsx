"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import {
  BRICK_PRESETS,
  calcBrickFrontend,
  calcConcreteFrontendMix,
  calcHouseCost,
  calcPaint,
  calcPlaster,
  calcSlabSteelFrontend,
  calcSteelColumnFrontend,
  calcTile,
  calcTwoWaySlabFrontend,
  calcWaterproofing,
  concreteVolumeM3,
  rmcNetVolumeM3,
} from "@/lib/calc-shared";

type CalcCategory = "steel" | "concrete" | "masonry" | "finishes" | "finance";
type CalcType =
  | "steel_column"
  | "steel_slab"
  | "steel_twoway"
  | "concrete"
  | "rmc"
  | "bricks"
  | "paint"
  | "tile"
  | "plaster"
  | "waterproofing"
  | "house_cost";

const HOUSE_RATE_DEFAULTS: Record<"budget" | "standard" | "premium", number> = {
  budget: 1600,
  standard: 2200,
  premium: 3400,
};

const CALC_TITLES: Record<string, string> = {
  steel_column: "Column Steel",
  steel_slab: "One-Way Slab Steel",
  steel_twoway: "Two-Way Slab Steel",
  concrete: "Concrete Volume",
  rmc: "RMC Mixer",
  bricks: "Brickwork & Blockwork",
  plaster: "Plastering",
  paint: "Painting & Primer",
  tile: "Tile Flooring",
  waterproofing: "Waterproofing",
  house_cost: "House Construction Cost",
  brickwork_blockwork: "Brickwork & Blockwork",
  shuttering_formwork: "Shuttering & Formwork",
};

export default function CalculatorsPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [activeCategory, setActiveCategory] = useState<CalcCategory>("steel");
  const [activeCalc, setActiveCalc] = useState<CalcType>("steel_column");

  // --- STATE DECLARATIONS ---

  // 1. Column Steel
  const [colHeight, setColHeight] = useState(3000); // mm
  const [slabThick, setSlabThick] = useState(150); // mm
  const [sizeA, setSizeA] = useState(450); // mm
  const [sizeB, setSizeB] = useState(300); // mm
  const [mainBarDia, setMainBarDia] = useState(20); // mm
  const [mainBarCount, setMainBarCount] = useState(4); // nos
  const [stirrupDia, setStirrupDia] = useState(8); // mm
  const [stirrupSpacing, setStirrupSpacing] = useState(150); // mm
  const [steelPrice, setSteelPrice] = useState(0); // ₹/kg
  const [steelWastage, setSteelWastage] = useState(5); // %

  // 2. Slab Steel
  const [slabLength, setSlabLength] = useState(8000); // mm (Ly)
  const [slabWidth, setSlabWidth] = useState(4000); // mm (Lx)
  const [slabMainDia, setSlabMainDia] = useState(12); // mm
  const [slabMainSpacing, setSlabMainSpacing] = useState(150); // mm
  const [slabDistDia, setSlabDistDia] = useState(8); // mm
  const [slabDistSpacing, setSlabDistSpacing] = useState(200); // mm

  // 2b. Two-Way Slab Steel
  const [tw2Lx, setTw2Lx] = useState(4000); // mm
  const [tw2Ly, setTw2Ly] = useState(5000); // mm
  const [tw2XDia, setTw2XDia] = useState(12);
  const [tw2XSp, setTw2XSp] = useState(150);
  const [tw2YDia, setTw2YDia] = useState(10);
  const [tw2YSp, setTw2YSp] = useState(150);
  const [tw2DevLen, setTw2DevLen] = useState(300);

  // Steel Column dual-zone & secondary bar
  const [colBar2Dia, setColBar2Dia] = useState(0);
  const [colBar2Count, setColBar2Count] = useState(0);
  const [colSpEnd, setColSpEnd] = useState(150);
  const [colSpMid, setColSpMid] = useState(200);
  const [slabDevLen, setSlabDevLen] = useState(300);

  // 3. Concrete Volume & Mix
  const [concreteForm, setConcreteForm] = useState<"slab" | "column" | "circular" | "footing" | "stair">("slab");
  const [concreteL, setConcreteL] = useState(5.0); // m
  const [concreteW, setConcreteW] = useState(3.0); // m
  const [concreteD, setConcreteD] = useState(0.15); // m
  const [concColA, setConcColA] = useState(450); // mm (own state - not shared with the Steel Column tab)
  const [concColB, setConcColB] = useState(300); // mm
  const [concColH, setConcColH] = useState(3000); // mm
  const [concreteGrade, setConcreteGrade] = useState("M20");
  const [concreteWastage, setConcreteWastage] = useState(5); // %
  const [stairSteps, setStairSteps] = useState(14);
  const [stairWidth, setStairWidth] = useState(1.2); // m
  const [stairRiser, setStairRiser] = useState(0.15); // m
  const [stairTread, setStairTread] = useState(0.25); // m
  const [stairWaist, setStairWaist] = useState(0.15); // m
  const [circDia, setCircDia] = useState(0.45); // m
  const [circHeight, setCircHeight] = useState(3.0); // m
  const [circCount, setCircCount] = useState(1);
  const [cementRate, setCementRate] = useState(0);
  const [sandRate, setSandRate] = useState(0);
  const [aggRate, setAggRate] = useState(0);

  // 4. RMC Transit Mixer
  const [rmcVolume, setRmcVolume] = useState(15.0); // m3
  const [rmcMixerSize, setRmcMixerSize] = useState(6.0); // m3
  const [rmcWastage, setRmcWastage] = useState(5); // %
  const [rmcTab, setRmcTab] = useState<"direct" | "slab" | "column" | "beam" | "footing">("direct");
  const [rmcGrade, setRmcGrade] = useState("M25");
  const [rmcSlabL, setRmcSlabL] = useState(10);
  const [rmcSlabW, setRmcSlabW] = useState(6);
  const [rmcSlabT, setRmcSlabT] = useState(150);
  const [rmcColA, setRmcColA] = useState(450);
  const [rmcColB, setRmcColB] = useState(300);
  const [rmcColH, setRmcColH] = useState(3);
  const [rmcColCount, setRmcColCount] = useState(4);
  const [rmcBeamL, setRmcBeamL] = useState(6);
  const [rmcBeamW, setRmcBeamW] = useState(230);
  const [rmcBeamD, setRmcBeamD] = useState(450);
  const [rmcBeamCount, setRmcBeamCount] = useState(2);
  const [rmcFootL, setRmcFootL] = useState(1.5);
  const [rmcFootW, setRmcFootW] = useState(1.5);
  const [rmcFootD, setRmcFootD] = useState(0.4);
  const [rmcFootCount, setRmcFootCount] = useState(6);
  const [rmcRate, setRmcRate] = useState(0);

  // 5. Bricks & Mortar
  const [brickWallL, setBrickWallL] = useState(5.0); // m
  const [brickWallH, setBrickWallH] = useState(3.0); // m
  const [brickSizePreset, setBrickSizePreset] = useState("modular"); // modular / traditional / uk / us
  const [brickMortarRatio, setBrickMortarRatio] = useState("1:6");
  const [brickLeaves, setBrickLeaves] = useState<1 | 2>(2); // wall thickness derives from preset width + joint
  const [brickWastage, setBrickWastage] = useState(10); // %
  const [brickMortarJoint, setBrickMortarJoint] = useState(10); // mm
  const [brickPrice, setBrickPrice] = useState(0); // price per brick

  // 6. Paint Quantity
  const [roomL, setRoomL] = useState(15.0); // ft
  const [roomW, setRoomW] = useState(12.0); // ft
  const [ceilingH, setCeilingH] = useState(10.0); // ft
  const [paintCeiling, setPaintCeiling] = useState(true);
  const [doorsCount, setDoorsCount] = useState(2);
  const [windowsCount, setWindowsCount] = useState(3);
  const [paintCoats, setPaintCoats] = useState(2);
  const [paintQuality, setPaintQuality] = useState("premium"); // economy / premium / luxury / texture

  // 7. Tile Flooring
  const [tileRoomL, setTileRoomL] = useState(12.0); // ft
  const [tileRoomW, setTileRoomW] = useState(10.0); // ft
  const [tileLInch, setTileLInch] = useState(24.0); // inch
  const [tileWInch, setTileWInch] = useState(24.0); // inch
  const [tileGrout, setTileGrout] = useState(2.0); // mm
  const [tileWastage, setTileWastage] = useState(10); // %

  // 8. Plastering
  const [plasterArea, setPlasterArea] = useState(50.0); // m2
  const [plasterThick, setPlasterThick] = useState(12.0); // mm
  const [plasterRatio, setPlasterRatio] = useState("1:4");
  const [plasterWastage, setPlasterWastage] = useState(10); // %

  // 9. Waterproofing
  const [wpArea, setWpArea] = useState(250.0); // sqft
  const [wpCoverage, setWpCoverage] = useState(60.0); // sqft/litre per coat
  const [wpCoats, setWpCoats] = useState(2);
  const [wpWastage, setWpWastage] = useState(5); // %

  // 10. House Cost
  const [houseArea, setHouseArea] = useState(1500); // sqft
  const [houseFloors, setHouseFloors] = useState(1); // G
  const [houseQuality, setHouseQuality] = useState<"budget" | "standard" | "premium">("standard");
  const [houseRate, setHouseRate] = useState(HOUSE_RATE_DEFAULTS.standard); // ₹/sqft, user-editable
  const [houseCompoundWall, setHouseCompoundWall] = useState(120); // ft
  const [houseContingency, setHouseContingency] = useState(10); // %

  // --- MEMOIZED CALCULATION LOGIC ---

  // 1. Steel Column Calculations — via shared module (single source, patchy-data safe)
  const { colBar1Weight, colBar2Weight, colStirrupWeight, colTotalWeight, colCost, colStirEnd, colStirMid, colStirrupCount } = React.useMemo(() => {
    const r = calcSteelColumnFrontend({
      colHeightMm: colHeight,
      slabThickMm: slabThick,
      sizeAMm: sizeA,
      sizeBMm: sizeB,
      mainBarDiaMm: mainBarDia,
      mainBarCount: mainBarCount,
      stirrupDiaMm: stirrupDia,
      stirrupSpacingMm: stirrupSpacing,
      colBar2DiaMm: colBar2Dia,
      colBar2Count: colBar2Count,
      colSpEndMm: colSpEnd,
      colSpMidMm: colSpMid,
      wastagePct: steelWastage,
      pricePerKg: steelPrice,
    });
    return { colBar1Weight: r.bar1WeightKg, colBar2Weight: r.bar2WeightKg, colStirrupWeight: r.stirrupWeightKg, colTotalWeight: r.totalWeightKg, colCost: r.cost, colStirEnd: r.stirEndCount, colStirMid: r.stirMidCount, colStirrupCount: r.stirrupCount };
  }, [mainBarDia, colHeight, slabThick, mainBarCount, colBar2Dia, colBar2Count, stirrupDia, sizeA, sizeB, colSpEnd, stirrupSpacing, colSpMid, steelWastage, steelPrice]);

  // 2. Slab Steel Calculations — via shared module
  const { slabMainWeight, slabDistWeight, slabTotalWeight, slabCost, slabMainCount, slabDistCount } = React.useMemo(() => {
    const r = calcSlabSteelFrontend({
      slabLengthMm: slabLength,
      slabWidthMm: slabWidth,
      mainDiaMm: slabMainDia,
      mainSpacingMm: slabMainSpacing,
      distDiaMm: slabDistDia,
      distSpacingMm: slabDistSpacing,
      devLenMm: slabDevLen,
      wastagePct: steelWastage,
      pricePerKg: steelPrice,
    });
    return { slabMainWeight: r.mainWeightKg, slabDistWeight: r.distWeightKg, slabTotalWeight: r.totalWeightKg, slabCost: r.cost, slabMainCount: r.mainCount, slabDistCount: r.distCount };
  }, [slabMainDia, slabLength, slabMainSpacing, slabWidth, slabDevLen, slabDistDia, slabDistSpacing, steelWastage, steelPrice]);

  // 2b. Two-Way Slab Steel — via shared module
  const { tw2XWeight, tw2YWeight, tw2TotalWeight, tw2Cost, tw2XCount, tw2YCount } = React.useMemo(() => {
    const r = calcTwoWaySlabFrontend({
      lxMm: tw2Lx,
      lyMm: tw2Ly,
      xDiaMm: tw2XDia,
      xSpacingMm: tw2XSp,
      yDiaMm: tw2YDia,
      ySpacingMm: tw2YSp,
      devLenMm: tw2DevLen,
      wastagePct: steelWastage,
      pricePerKg: steelPrice,
    });
    return { tw2XWeight: r.xWeightKg, tw2YWeight: r.yWeightKg, tw2TotalWeight: r.totalWeightKg, tw2Cost: r.cost, tw2XCount: r.xCount, tw2YCount: r.yCount };
  }, [tw2XDia, tw2Ly, tw2XSp, tw2Lx, tw2DevLen, tw2YDia, tw2YSp, steelWastage, steelPrice]);

  // 3. Concrete Volume & Mix — via shared module (dry 1.54, single source)
  const { concVolume, concCementBags, concSandM3, concAggM3, concMaterialCost } = React.useMemo(() => {
    const vol = concreteVolumeM3({
      form: concreteForm,
      slabL: concreteL,
      slabW: concreteW,
      slabD: concreteD,
      colAmm: concColA,
      colBmm: concColB,
      colHmm: concColH,
      circDiaM: circDia,
      circHeightM: circHeight,
      circCount: circCount,
      stairSteps: stairSteps,
      stairWidthM: stairWidth,
      stairRiserM: stairRiser,
      stairTreadM: stairTread,
      stairWaistM: stairWaist,
    });
    const mix = calcConcreteFrontendMix(vol, concreteGrade, concreteWastage);
    const cost = (cementRate > 0 ? Math.ceil(mix.cementBags) * cementRate : 0) + (sandRate > 0 ? mix.sandM3 * sandRate : 0) + (aggRate > 0 ? mix.aggM3 * aggRate : 0);
    return { concVolume: mix.volumeM3, concCementBags: mix.cementBags, concSandM3: mix.sandM3, concAggM3: mix.aggM3, concMaterialCost: cost };
  }, [concreteL, concreteW, concreteD, concreteForm, concColA, concColB, concColH, circDia, circHeight, circCount, stairSteps, stairWidth, stairRiser, stairTread, stairWaist, concreteGrade, concreteWastage, cementRate, sandRate, aggRate]);

  // 4. RMC Transit Mixer — via shared module
  const { rmcTotalVol, rmcTrucks, rmcTotalCost } = React.useMemo(() => {
    const netVol = rmcNetVolumeM3({
      tab: rmcTab,
      directVolM3: rmcVolume,
      slabL: rmcSlabL,
      slabW: rmcSlabW,
      slabTMm: rmcSlabT,
      colAMm: rmcColA,
      colBMm: rmcColB,
      colHM: rmcColH,
      colCount: rmcColCount,
      beamLM: rmcBeamL,
      beamWMm: rmcBeamW,
      beamDMm: rmcBeamD,
      beamCount: rmcBeamCount,
      footLM: rmcFootL,
      footWM: rmcFootW,
      footDM: rmcFootD,
      footCount: rmcFootCount,
    });
    const totVol = netVol * (1 + rmcWastage / 100);
    const trucks = Math.ceil(totVol / rmcMixerSize);
    const cost = rmcRate > 0 ? totVol * rmcRate : 0;
    return { rmcTotalVol: totVol, rmcTrucks: trucks, rmcTotalCost: cost };
  }, [rmcVolume, rmcTab, rmcSlabL, rmcSlabW, rmcSlabT, rmcColA, rmcColB, rmcColH, rmcColCount, rmcBeamL, rmcBeamW, rmcBeamD, rmcBeamCount, rmcFootL, rmcFootW, rmcFootD, rmcFootCount, rmcWastage, rmcMixerSize, rmcRate]);

  // 5. Bricks & Mortar — via shared module
  const { bricksNeeded, brickCementBags, brickSandM3, brickTotalCost } = React.useMemo(() => {
    const r = calcBrickFrontend({
      wallLM: brickWallL,
      wallHM: brickWallH,
      preset: brickSizePreset,
      mortarJointMm: brickMortarJoint,
      leaves: brickLeaves,
      wastagePct: brickWastage,
      mortarRatio: brickMortarRatio,
    });
    const cost = brickPrice > 0 ? r.bricksNeeded * brickPrice : 0;
    return { bricksNeeded: r.bricksNeeded, brickCementBags: r.cementBags, brickSandM3: r.sandM3, brickTotalCost: cost };
  }, [brickSizePreset, brickMortarJoint, brickWallL, brickWallH, brickLeaves, brickWastage, brickMortarRatio, brickPrice]);

  const selBrickWidthMm = (BRICK_PRESETS[brickSizePreset] || BRICK_PRESETS.modular)[1];

  // 6. Paint Quantity — via shared module (unified coverage: premium 135)
  const { paintableArea, paintLitres, paintPuttyKg, paintPrimerL } = React.useMemo(() => {
    const r = calcPaint({
      roomLengthFt: roomL,
      roomWidthFt: roomW,
      ceilingHeightFt: ceilingH,
      paintCeiling,
      doorsCount,
      windowsCount,
      coats: paintCoats,
      quality: paintQuality,
    });
    return { paintableArea: r.paintableAreaSqft, paintLitres: r.paintLitres, paintPuttyKg: r.puttyKg, paintPrimerL: r.primerLitres };
  }, [roomL, roomW, ceilingH, paintCeiling, doorsCount, windowsCount, paintQuality, paintCoats]);

  // 7. Tile Flooring — via shared module
  const { tileRoomArea, tileTiles } = React.useMemo(() => {
    const r = calcTile({ lengthFt: tileRoomL, widthFt: tileRoomW, tileLengthInch: tileLInch, tileWidthInch: tileWInch, groutMm: tileGrout, wastagePct: tileWastage });
    return { tileRoomArea: r.roomAreaSqft, tileTiles: r.tilesNeeded };
  }, [tileRoomL, tileRoomW, tileGrout, tileLInch, tileWInch, tileWastage]);

  // 8. Plastering — via shared module
  const { plasterWetVol, plasterCementBags, plasterSandM3 } = React.useMemo(() => {
    const r = calcPlaster({ wallAreaM2: plasterArea, thicknessMm: plasterThick, mixRatio: plasterRatio, wastagePct: plasterWastage });
    return { plasterWetVol: r.wetVolumeM3, plasterCementBags: r.cementBags, plasterSandM3: r.sandM3 };
  }, [plasterArea, plasterThick, plasterWastage, plasterRatio]);

  // 9. Waterproofing — via shared module
  const wpLitres = React.useMemo(() => {
    return calcWaterproofing({ areaSqft: wpArea, coverageSqftPerLitre: wpCoverage, coats: wpCoats, wastagePct: wpWastage }).litresNeeded;
  }, [wpArea, wpCoverage, wpCoats, wpWastage]);

  // 10. House Construction Cost — via shared module (mirrors POST /apis/v3/calculators/house-cost)
  const { houseProjectCost, houseContingencyCost, houseSplits } = React.useMemo(() => {
    const r = calcHouseCost({ areaSqft: houseArea, baseRate: houseRate, floors: houseFloors, compoundWallLengthFt: houseCompoundWall, contingencyPct: houseContingency });
    const splits = [
      { name: "Structure & Civil (40%)", percentage: 0.40, color: "bg-primary" },
      { name: "Finishing & Masonry (25%)", percentage: 0.25, color: "bg-primary" },
      { name: "MEP & Fittings (15%)", percentage: 0.15, color: "bg-success" },
      { name: "Interior & Carpentry (12%)", percentage: 0.12, color: "bg-warning" },
      { name: "Consultants & Permits (8%)", percentage: 0.08, color: "bg-elevated" },
    ];
    return { houseProjectCost: r.totalProjectCost, houseContingencyCost: r.contingencyBuffer, houseSplits: splits };
  }, [houseRate, houseFloors, houseArea, houseCompoundWall, houseContingency]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={`${CALC_TITLES[activeCalc] || activeCalc.replace(/_/g, " ")} Quantity Estimator`}
        subtitle="IS 456 & CPWD standard quantity takeoff engine"
      >
        {/* Calculator Selector Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {[
            { id: "steel_column", label: "Col Steel", cat: "steel" },
            { id: "steel_slab", label: "1-Way Slab", cat: "steel" },
            { id: "steel_twoway", label: "2-Way Slab", cat: "steel" },
            { id: "concrete", label: "Concrete Vol", cat: "concrete" },
            { id: "rmc", label: "RMC Mixer", cat: "concrete" },
            { id: "bricks", label: "Bricks", cat: "masonry" },
            { id: "plaster", label: "Plaster", cat: "masonry" },
            { id: "paint", label: "Paint", cat: "finishes" },
            { id: "tile", label: "Tile", cat: "finishes" },
            { id: "waterproofing", label: "Waterproofing", cat: "finishes" },
            { id: "house_cost", label: "House Cost", cat: "finance" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveCalc(tab.id as any);
                setActiveCategory(tab.cat as any);
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all cursor-pointer ${
                activeCalc === tab.id
                  ? "bg-primary text-white font-bold"
                  : "bg-input text-muted hover:text-foreground hover:bg-elevated border border-border-custom"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          {/* Content Panel */}
          <div className="space-y-8">
          {/* CALCULATOR PANELS */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* INPUT PANEL */}
            <div className="lg:col-span-2 rounded-lg border border-border-custom bg-card p-6 space-y-6">
              <div className="flex justify-between items-center border-b border-border-custom pb-3">
                <h3 className="font-bold text-sm uppercase tracking-wider text-foreground">
                  Takeoff Parameters
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-success/10 text-success border border-success/20 font-bold">
                  Active Formula
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
                {/* 1. Steel Column Inputs */}
                {/* 1. Steel Column Inputs */}
                {activeCalc === "steel_column" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Column Height (mm)</label>
                      <input
                        type="number"
                        value={colHeight}
                        onChange={(e) => {
                          setColHeight(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Slab Thickness (mm)</label>
                      <input
                        type="number"
                        value={slabThick}
                        onChange={(e) => {
                          setSlabThick(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Column Size A (mm)</label>
                      <input
                        type="number"
                        value={sizeA}
                        onChange={(e) => {
                          setSizeA(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Column Size B (mm)</label>
                      <input
                        type="number"
                        value={sizeB}
                        onChange={(e) => {
                          setSizeB(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar 1 Dia (mm)</label>
                      <select
                        value={mainBarDia}
                        onChange={(e) => {
                          setMainBarDia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      >
                        {[8, 10, 12, 16, 20, 25, 32].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar 1 Count (nos)</label>
                      <input
                        type="number"
                        value={mainBarCount}
                        onChange={(e) => {
                          setMainBarCount(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar 2 Dia (optional)</label>
                      <select
                        value={colBar2Dia}
                        onChange={(e) => {
                          setColBar2Dia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      >
                        <option value={0}>None</option>
                        {[8, 10, 12, 16, 20, 25].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar 2 Count (nos)</label>
                      <input
                        type="number"
                        value={colBar2Count}
                        onChange={(e) => {
                          setColBar2Count(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Stirrup End-Zone Spacing (l/4)</label>
                      <input
                        type="number"
                        value={colSpEnd}
                        onChange={(e) => {
                          setColSpEnd(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Stirrup Mid-Span Spacing</label>
                      <input
                        type="number"
                        value={colSpMid}
                        onChange={(e) => {
                          setColSpMid(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Wastage Buffer (%)</label>
                      <input
                        type="number"
                        value={steelWastage}
                        onChange={(e) => {
                          setSteelWastage(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Steel Rate / kg (₹)</label>
                      <input
                        type="number"
                        value={steelPrice}
                        onChange={(e) => {
                          setSteelPrice(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                  </>
                )}

                {/* 2. One-Way Slab Steel Inputs */}
                {activeCalc === "steel_slab" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Slab Length Ly (mm)</label>
                      <input
                        type="number"
                        value={slabLength}
                        onChange={(e) => {
                          setSlabLength(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Slab Width Lx (mm)</label>
                      <input
                        type="number"
                        value={slabWidth}
                        onChange={(e) => {
                          setSlabWidth(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar Dia (mm)</label>
                      <select
                        value={slabMainDia}
                        onChange={(e) => {
                          setSlabMainDia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        {[8, 10, 12, 16].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Main Bar Spacing (mm)</label>
                      <input
                        type="number"
                        value={slabMainSpacing}
                        onChange={(e) => {
                          setSlabMainSpacing(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Distribution Bar Dia (mm)</label>
                      <select
                        value={slabDistDia}
                        onChange={(e) => {
                          setSlabDistDia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        {[8, 10, 12].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Distribution Bar Spacing (mm)</label>
                      <input
                        type="number"
                        value={slabDistSpacing}
                        onChange={(e) => {
                          setSlabDistSpacing(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Development Length Ld per end (mm)</label>
                      <input
                        type="number"
                        value={slabDevLen}
                        onChange={(e) => {
                          setSlabDevLen(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Steel Rate / kg (₹)</label>
                      <input
                        type="number"
                        value={steelPrice}
                        onChange={(e) => {
                          setSteelPrice(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 2b. Two-Way Slab Steel Inputs */}
                {activeCalc === "steel_twoway" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Shorter Span Lx (mm)</label>
                      <input
                        type="number"
                        value={tw2Lx}
                        onChange={(e) => {
                          setTw2Lx(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Longer Span Ly (mm)</label>
                      <input
                        type="number"
                        value={tw2Ly}
                        onChange={(e) => {
                          setTw2Ly(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Shorter Span Bar Dia (mm)</label>
                      <select
                        value={tw2XDia}
                        onChange={(e) => {
                          setTw2XDia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        {[8, 10, 12, 16, 20].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Shorter Span Spacing (mm)</label>
                      <input
                        type="number"
                        value={tw2XSp}
                        onChange={(e) => {
                          setTw2XSp(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Longer Span Bar Dia (mm)</label>
                      <select
                        value={tw2YDia}
                        onChange={(e) => {
                          setTw2YDia(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        {[8, 10, 12, 16].map((d) => (
                          <option key={d} value={d}>
                            {d} mm
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Longer Span Spacing (mm)</label>
                      <input
                        type="number"
                        value={tw2YSp}
                        onChange={(e) => {
                          setTw2YSp(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Development Length Ld per end (mm)</label>
                      <input
                        type="number"
                        value={tw2DevLen}
                        onChange={(e) => {
                          setTw2DevLen(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Steel Rate / kg (₹)</label>
                      <input
                        type="number"
                        value={steelPrice}
                        onChange={(e) => {
                          setSteelPrice(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 3. Concrete Volume & Mix */}
                {activeCalc === "concrete" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Element Category</label>
                      <select
                        value={concreteForm}
                        onChange={(e) => {
                          setConcreteForm(e.target.value as any);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="slab">Flat Slab / Beam</option>
                        <option value="column">Rectangular Column</option>
                        <option value="circular">Circular Column</option>
                        <option value="stair">Staircase Flight</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Concrete Grade</label>
                      <select
                        value={concreteGrade}
                        onChange={(e) => {
                          setConcreteGrade(e.target.value);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="M5">M5 (1:5:10 - Blinding/Levelling)</option>
                        <option value="M7_5">M7.5 (1:4:8 - Mass Concrete PCC)</option>
                        <option value="M10">M10 (Nominal PCC 1:3:6)</option>
                        <option value="M15">M15 (Nominal PCC 1:2:4)</option>
                        <option value="M20">M20 (Standard RCC 1:1.5:3)</option>
                        <option value="M25">M25 (High Strength 1:1:2)</option>
                      </select>
                    </div>

                    {concreteForm === "slab" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Slab Length (m)</label>
                          <input
                            type="number"
                            value={concreteL}
                            onChange={(e) => {
                              setConcreteL(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Slab Width (m)</label>
                          <input
                            type="number"
                            value={concreteW}
                            onChange={(e) => {
                              setConcreteW(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-muted">Slab Thickness / Depth (m)</label>
                          <input
                            type="number"
                            value={concreteD}
                            onChange={(e) => {
                              setConcreteD(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}

                    {concreteForm === "column" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Column Size A (mm)</label>
                          <input
                            type="number"
                            value={concColA}
                            onChange={(e) => {
                              setConcColA(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Column Size B (mm)</label>
                          <input
                            type="number"
                            value={concColB}
                            onChange={(e) => {
                              setConcColB(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-muted">Column Height (mm)</label>
                          <input
                            type="number"
                            value={concColH}
                            onChange={(e) => {
                              setConcColH(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}

                    {concreteForm === "circular" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Column Diameter (m)</label>
                          <input
                            type="number"
                            value={circDia}
                            onChange={(e) => {
                              setCircDia(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Column Height (m)</label>
                          <input
                            type="number"
                            value={circHeight}
                            onChange={(e) => {
                              setCircHeight(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-muted">No. of Columns</label>
                          <input
                            type="number"
                            value={circCount}
                            onChange={(e) => {
                              setCircCount(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}

                    {concreteForm === "stair" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Steps Count</label>
                          <input
                            type="number"
                            value={stairSteps}
                            onChange={(e) => {
                              setStairSteps(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Flight Width (m)</label>
                          <input
                            type="number"
                            value={stairWidth}
                            onChange={(e) => {
                              setStairWidth(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Riser Height (m)</label>
                          <input
                            type="number"
                            value={stairRiser}
                            onChange={(e) => {
                              setStairRiser(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Tread Depth (m)</label>
                          <input
                            type="number"
                            value={stairTread}
                            onChange={(e) => {
                              setStairTread(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1 col-span-2">
                          <label className="text-muted">Waist Slab Thickness (m)</label>
                          <input
                            type="number"
                            value={stairWaist}
                            onChange={(e) => {
                              setStairWaist(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-1">
                      <label className="text-muted">Cement Rate / Bag (₹)</label>
                      <input
                        type="number"
                        value={cementRate}
                        onChange={(e) => {
                          setCementRate(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Sand Rate / m³ (₹)</label>
                      <input
                        type="number"
                        value={sandRate}
                        onChange={(e) => {
                          setSandRate(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Aggregate Rate / m³ (₹)</label>
                      <input
                        type="number"
                        value={aggRate}
                        onChange={(e) => {
                          setAggRate(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 4. RMC Transit Mixer */}
                {activeCalc === "rmc" && (
                  <>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Calculation Target Structure</label>
                      <select
                        value={rmcTab}
                        onChange={(e) => {
                          setRmcTab(e.target.value as any);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="direct">Direct Volume Input</option>
                        <option value="slab">Slab Element</option>
                        <option value="column">Rectangular Columns</option>
                        <option value="beam">Beams Element</option>
                        <option value="footing">Footings Element</option>
                      </select>
                    </div>

                    {rmcTab === "direct" && (
                      <div className="space-y-1">
                        <label className="text-muted">Pour Volume (m³)</label>
                        <input
                          type="number"
                          value={rmcVolume}
                          onChange={(e) => {
                            setRmcVolume(Number(e.target.value));
                          }}
                          className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                        />
                      </div>
                    )}
                    {rmcTab === "slab" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Slab Length (m)</label>
                          <input
                            type="number"
                            value={rmcSlabL}
                            onChange={(e) => {
                              setRmcSlabL(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Slab Width (m)</label>
                          <input
                            type="number"
                            value={rmcSlabW}
                            onChange={(e) => {
                              setRmcSlabW(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Thickness (mm)</label>
                          <input
                            type="number"
                            value={rmcSlabT}
                            onChange={(e) => {
                              setRmcSlabT(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}
                    {rmcTab === "column" && (
                      <>
                        <div className="space-y-1">
                          <label className="text-muted">Column A (mm)</label>
                          <input
                            type="number"
                            value={rmcColA}
                            onChange={(e) => {
                              setRmcColA(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Column B (mm)</label>
                          <input
                            type="number"
                            value={rmcColB}
                            onChange={(e) => {
                              setRmcColB(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">Height (m)</label>
                          <input
                            type="number"
                            value={rmcColH}
                            onChange={(e) => {
                              setRmcColH(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted">No. of Columns</label>
                          <input
                            type="number"
                            value={rmcColCount}
                            onChange={(e) => {
                              setRmcColCount(Number(e.target.value));
                            }}
                            className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-1">
                      <label className="text-muted">Mixer Truck Size (m³)</label>
                      <select
                        value={rmcMixerSize}
                        onChange={(e) => {
                          setRmcMixerSize(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value={6}>6 m³ (Standard India)</option>
                        <option value={7}>7 m³ (Standard GCC)</option>
                        <option value={8}>8 m³ (Heavy Infra)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">RMC Rate / m³ (₹)</label>
                      <input
                        type="number"
                        value={rmcRate}
                        onChange={(e) => {
                          setRmcRate(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 5. Bricks Wall */}
                {activeCalc === "bricks" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Wall Length (m)</label>
                      <input
                        type="number"
                        value={brickWallL}
                        onChange={(e) => {
                          setBrickWallL(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Wall Height (m)</label>
                      <input
                        type="number"
                        value={brickWallH}
                        onChange={(e) => {
                          setBrickWallH(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Brick Size Standard</label>
                      <select
                        value={brickSizePreset}
                        onChange={(e) => {
                          setBrickSizePreset(e.target.value);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="modular">India Modular (190 x 90 x 90 mm)</option>
                        <option value="traditional">India Traditional (230 x 110 x 75 mm)</option>
                        <option value="uk">UK BS 3921 (215 x 102 x 65 mm)</option>
                        <option value="us">US ASTM (203 x 92 x 95 mm)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Mortar Joint (mm)</label>
                      <input
                        type="number"
                        value={brickMortarJoint}
                        onChange={(e) => {
                          setBrickMortarJoint(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Wall Thickness</label>
                      <select
                        value={brickLeaves}
                        onChange={(e) => {
                          setBrickLeaves(Number(e.target.value) as 1 | 2);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value={1}>{`Single Leaf (${selBrickWidthMm + brickMortarJoint} mm)`}</option>
                        <option value={2}>{`Double Leaf (${2 * selBrickWidthMm + brickMortarJoint} mm)`}</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Mortar Mix Ratio</label>
                      <select
                        value={brickMortarRatio}
                        onChange={(e) => {
                          setBrickMortarRatio(e.target.value);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="1:3">1:3 (High Strength)</option>
                        <option value="1:4">1:4 (External Walls)</option>
                        <option value="1:6">1:6 (Internal Walls)</option>
                      </select>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-muted">Price per Brick (₹)</label>
                      <input
                        type="number"
                        value={brickPrice}
                        onChange={(e) => {
                          setBrickPrice(Number(e.target.value));
                        }}
                        placeholder="Optional"
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 6. Paint & Putty */}
                {activeCalc === "paint" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Paint Type / Quality</label>
                      <select
                        value={paintQuality}
                        onChange={(e) => {
                          setPaintQuality(e.target.value);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="economy">Economy Emulsion (115 sqft/L)</option>
                        <option value="premium">Premium Emulsion (140 sqft/L)</option>
                        <option value="luxury">Luxury / Sheen (155 sqft/L)</option>
                        <option value="texture">Texture Paint (80 sqft/L)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Room Length (ft)</label>
                      <input
                        type="number"
                        value={roomL}
                        onChange={(e) => {
                          setRoomL(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Room Width (ft)</label>
                      <input
                        type="number"
                        value={roomW}
                        onChange={(e) => {
                          setRoomW(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Ceiling Height (ft)</label>
                      <input
                        type="number"
                        value={ceilingH}
                        onChange={(e) => {
                          setCeilingH(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Coats Count</label>
                      <input
                        type="number"
                        value={paintCoats}
                        onChange={(e) => {
                          setPaintCoats(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Doors Count (21 sqft each)</label>
                      <input
                        type="number"
                        value={doorsCount}
                        onChange={(e) => {
                          setDoorsCount(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Windows Count (12 sqft each)</label>
                      <input
                        type="number"
                        value={windowsCount}
                        onChange={(e) => {
                          setWindowsCount(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-4 col-span-2">
                      <input
                        type="checkbox"
                        checked={paintCeiling}
                        onChange={(e) => {
                          setPaintCeiling(e.target.checked);
                        }}
                        className="h-4 w-4 bg-input rounded"
                      />
                      <label className="text-muted">Include Ceiling Area</label>
                    </div>
                  </>
                )}

                {/* 7. Tile Flooring */}
                {activeCalc === "tile" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Room Length (ft)</label>
                      <input
                        type="number"
                        value={tileRoomL}
                        onChange={(e) => {
                          setTileRoomL(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Room Width (ft)</label>
                      <input
                        type="number"
                        value={tileRoomW}
                        onChange={(e) => {
                          setTileRoomW(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Tile Size (Length - Inch)</label>
                      <input
                        type="number"
                        value={tileLInch}
                        onChange={(e) => {
                          setTileLInch(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Tile Size (Width - Inch)</label>
                      <input
                        type="number"
                        value={tileWInch}
                        onChange={(e) => {
                          setTileWInch(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 8. Plastering */}
                {activeCalc === "plaster" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Wall Area (m²)</label>
                      <input
                        type="number"
                        value={plasterArea}
                        onChange={(e) => {
                          setPlasterArea(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Plaster Thickness (mm)</label>
                      <input
                        type="number"
                        value={plasterThick}
                        onChange={(e) => {
                          setPlasterThick(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Plaster Mix Ratio (Cement:Sand)</label>
                      <select
                        value={plasterRatio}
                        onChange={(e) => {
                          setPlasterRatio(e.target.value);
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value="1:3">1:3 (Ceilings / Wet areas)</option>
                        <option value="1:4">1:4 (Internal plaster standard)</option>
                        <option value="1:6">1:6 (External/Rough plaster)</option>
                      </select>
                    </div>
                  </>
                )}

                {/* 9. Waterproofing */}
                {activeCalc === "waterproofing" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Waterproofing Area (sqft)</label>
                      <input
                        type="number"
                        value={wpArea}
                        onChange={(e) => {
                          setWpArea(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Coverage per Litre (sqft/L)</label>
                      <input
                        type="number"
                        value={wpCoverage}
                        onChange={(e) => {
                          setWpCoverage(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}

                {/* 10. House Cost Estimator */}
                {activeCalc === "house_cost" && (
                  <>
                    <div className="space-y-1">
                      <label className="text-muted">Built-Up Area (sqft)</label>
                      <input
                        type="number"
                        value={houseArea}
                        onChange={(e) => {
                          setHouseArea(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Floors Count</label>
                      <select
                        value={houseFloors}
                        onChange={(e) => {
                          setHouseFloors(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      >
                        <option value={1}>G floor (1 floor)</option>
                        <option value={2}>G+1 (2 floors)</option>
                        <option value={3}>G+2 (3 floors)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Construction Grade</label>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                        {(["budget", "standard", "premium"] as const).map((q) => (
                          <button
                            key={q}
                            onClick={() => {
                              setHouseQuality(q);
                              setHouseRate(HOUSE_RATE_DEFAULTS[q]);
                            }}
                            className={`py-1.5 px-2 border rounded-md uppercase text-[10px] font-bold transition-all cursor-pointer ${
                              houseQuality === q
                                ? "bg-elevated text-foreground font-semibold border-border-custom"
                                : "border-border-custom bg-card text-muted hover:bg-elevated/40"
                            }`}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Base Rate (₹/sqft)</label>
                      <input
                        type="number"
                        min={0}
                        value={houseRate}
                        onChange={(e) => {
                          setHouseRate(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                      <span className="text-[9px] text-muted block">
                        Loaded defaults: budget 1600, standard 2200, premium 3400. Edit to your own market rate.
                      </span>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Compound Wall Length (ft)</label>
                      <input
                        type="number"
                        min={0}
                        value={houseCompoundWall}
                        onChange={(e) => {
                          setHouseCompoundWall(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                      <span className="text-[9px] text-muted block">Priced at 35% of the base rate. Set 0 to exclude.</span>
                    </div>
                    <div className="space-y-1">
                      <label className="text-muted">Contingency (%)</label>
                      <input
                        type="number"
                        min={0}
                        value={houseContingency}
                        onChange={(e) => {
                          setHouseContingency(Number(e.target.value));
                        }}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-foreground"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* RESULTS OUTPUT PANEL */}
            <div className="rounded-lg border border-border-custom bg-card p-6 space-y-6 flex flex-col justify-between">
              <div className="space-y-5">
                <div className="border-b border-border-custom pb-3">
                  <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Calculated Result
                  </h4>
                </div>

                {/* 1. Steel Column Results */}
                {activeCalc === "steel_column" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Main Vertical Steel (Bar 1 & 2)
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {(colBar1Weight + colBar2Weight).toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        Bar 1: {mainBarCount} × {mainBarDia}mm ({colBar1Weight.toFixed(1)}kg) {colBar2Dia > 0 ? `| Bar 2: ${colBar2Count} × ${colBar2Dia}mm (${colBar2Weight.toFixed(1)}kg)` : ""}
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Dual-Zone Stirrups / Ties
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {colStirrupWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        {colStirrupCount} stirrups (End zone {colStirEnd}×2 + Mid span {colStirMid})
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Total Column Steel Weight
                      </span>
                      <strong className="text-2xl font-black text-success mt-1 block">
                        {colTotalWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        Includes {steelWastage}% wastage
                      </span>
                    </div>
                    {steelPrice > 0 && (
                      <div className="pt-4 border-t border-border-custom bg-input p-4 rounded-md flex items-center justify-between">
                        <div>
                          <span className="text-muted text-[10px] uppercase font-bold block">
                            Est. Material Cost
                          </span>
                          <strong className="text-xl font-black text-primary mt-1 block">
                            ₹{colCost.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. One-Way Slab Steel Results */}
                {activeCalc === "steel_slab" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Main Reinforcement
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {slabMainWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        {slabMainCount} main bars of {slabMainDia}mm diameter (Ld={slabDevLen}mm)
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Distribution Reinforcement
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {slabDistWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        {slabDistCount} distribution bars of {slabDistDia}mm diameter
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Total Slab Steel Weight
                      </span>
                      <strong className="text-2xl font-black text-success mt-1 block">
                        {slabTotalWeight.toFixed(2)} kg
                      </strong>
                    </div>
                  </div>
                )}

                {/* 2b. Two-Way Slab Steel Results */}
                {activeCalc === "steel_twoway" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Shorter Span Bars (Lx - Bottom)
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {tw2XWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        {tw2XCount} bars of {tw2XDia}mm diameter
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Longer Span Bars (Ly - Top)
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {tw2YWeight.toFixed(2)} kg
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        {tw2YCount} bars of {tw2YDia}mm diameter
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Total Two-Way Slab Steel Weight
                      </span>
                      <strong className="text-2xl font-black text-success mt-1 block">
                        {tw2TotalWeight.toFixed(2)} kg
                      </strong>
                    </div>
                    {steelPrice > 0 && (
                      <div className="bg-input p-4 rounded-md border border-border-custom">
                        <span className="text-muted text-[10px] uppercase font-bold block">Est. Cost</span>
                        <strong className="text-xl font-black text-primary mt-1 block">₹{tw2Cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Concrete Volume Results */}
                {activeCalc === "concrete" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Wet Concrete Volume
                      </span>
                      <strong className="text-xl font-black text-foreground mt-1 block">
                        {concVolume.toFixed(3)} m³
                      </strong>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Dry Mix Materials (1.54 Factor)
                      </span>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 mt-3 text-center">
                        <div className="bg-elevated p-2 rounded">
                          <strong className="text-sm font-bold text-foreground block">
                            {Math.ceil(concCementBags)}
                          </strong>
                          <span className="text-[9px] text-muted uppercase">Cement Bags</span>
                        </div>
                        <div className="bg-elevated p-2 rounded">
                          <strong className="text-sm font-bold text-foreground block">
                            {concSandM3.toFixed(2)}
                          </strong>
                          <span className="text-[9px] text-muted uppercase">Sand (m³)</span>
                        </div>
                        <div className="bg-elevated p-2 rounded">
                          <strong className="text-sm font-bold text-foreground block">
                            {concAggM3.toFixed(2)}
                          </strong>
                          <span className="text-[9px] text-muted uppercase">Aggregate (m³)</span>
                        </div>
                      </div>
                      <span className="text-[10px] text-muted italic block mt-2">
                        Includes {concreteWastage}% wastage allowance
                      </span>
                    </div>
                    {concMaterialCost > 0 && (
                      <div className="bg-input p-4 rounded-md border border-border-custom">
                        <span className="text-muted text-[10px] uppercase font-bold block">Est. Material Cost</span>
                        <strong className="text-xl font-black text-primary mt-1 block">₹{concMaterialCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                      </div>
                    )}
                    <span className="text-[10px] text-muted italic block">
                      * Cement bags rounded up to nearest whole bag. Nominal Mix proportions: {concreteGrade}.
                    </span>
                  </div>
                )}

                {/* 4. RMC Transit Mixer Truck Results */}
                {activeCalc === "rmc" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Transit Mixer Dispatches Needed
                      </span>
                      <strong className="text-4xl font-black text-success mt-2 block">
                        {rmcTrucks} Trucks
                      </strong>
                      <span className="text-[10px] text-muted block mt-2">
                        For a total wet pour of {rmcTotalVol.toFixed(2)} m³ (including {rmcWastage}% waste)
                      </span>
                    </div>
                    {rmcTotalCost > 0 && (
                      <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                        <span className="text-muted text-[10px] uppercase font-bold block">Estimated RMC Cost</span>
                        <strong className="text-2xl font-black text-primary mt-1 block">₹{rmcTotalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                      </div>
                    )}
                  </div>
                )}

                {/* 5. Brick Wall Results */}
                {activeCalc === "bricks" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Bricks Required
                      </span>
                      <strong className="text-3xl font-black text-success mt-1 block">
                        {bricksNeeded.toLocaleString("en-IN", { maximumFractionDigits: 2 })} nos
                      </strong>
                      <span className="text-[10px] text-muted block mt-1">
                        Includes {brickWastage}% cutting wastage buffer
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Dry Mortar Material Split
                      </span>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                        <div className="bg-elevated p-2 rounded text-center">
                          <strong className="text-sm font-bold text-foreground block">
                            {brickCementBags.toFixed(1)}
                          </strong>
                          <span className="text-[9px] text-muted uppercase">Cement Bags</span>
                        </div>
                        <div className="bg-elevated p-2 rounded text-center">
                          <strong className="text-sm font-bold text-foreground block">
                            {brickSandM3.toFixed(2)}
                          </strong>
                          <span className="text-[9px] text-muted uppercase">Sand (m³)</span>
                        </div>
                      </div>
                    </div>
                    {brickTotalCost > 0 && (
                      <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                        <span className="text-muted text-[10px] uppercase font-bold block">Est. Brick Cost</span>
                        <strong className="text-2xl font-black text-primary mt-1 block">₹{brickTotalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                      </div>
                    )}
                  </div>
                )}

                {/* 6. Paint & Putty Results */}
                {activeCalc === "paint" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Paintable Wall Area
                      </span>
                      <strong className="text-lg font-black text-foreground mt-1 block">
                        {paintableArea.toFixed(0)} sqft
                      </strong>
                      <span className="text-[10px] text-muted italic block mt-0.5">
                        After deducting {doorsCount} doors and {windowsCount} windows
                      </span>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-center">
                      <div className="bg-elevated p-2 rounded">
                        <strong className="text-sm font-bold text-foreground block">
                          {paintLitres.toFixed(1)} L
                        </strong>
                        <span className="text-[9px] text-muted uppercase">Paint</span>
                      </div>
                      <div className="bg-elevated p-2 rounded">
                        <strong className="text-sm font-bold text-foreground block">
                          {paintPuttyKg.toFixed(0)} kg
                        </strong>
                        <span className="text-[9px] text-muted uppercase">Putty</span>
                      </div>
                      <div className="bg-elevated p-2 rounded">
                        <strong className="text-sm font-bold text-foreground block">
                          {paintPrimerL.toFixed(1)} L
                        </strong>
                        <span className="text-[9px] text-muted uppercase">Primer</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 7. Tile Flooring Results */}
                {activeCalc === "tile" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Total Room Area
                      </span>
                      <strong className="text-xl font-black text-foreground mt-1 block">
                        {tileRoomArea.toFixed(1)} sqft
                      </strong>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Tiles Needed
                      </span>
                      <strong className="text-3xl font-black text-success mt-2 block">
                        {tileTiles} tiles
                      </strong>
                      <span className="text-[10px] text-muted block mt-1">
                        Includes {tileWastage}% breakage wastage buffer
                      </span>
                    </div>
                  </div>
                )}

                {/* 8. Plastering Results */}
                {activeCalc === "plaster" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Plaster Wet Volume
                      </span>
                      <strong className="text-base font-black text-foreground mt-1 block">
                        {plasterWetVol.toFixed(3)} m³
                      </strong>
                    </div>
                    <div className="bg-input p-4 rounded-md border border-border-custom grid grid-cols-1 md:grid-cols-2 gap-3 text-center">
                      <div>
                        <span className="text-muted text-[10px] uppercase font-bold block">
                          Cement Bags
                        </span>
                        <strong className="text-xl font-black text-success mt-1 block">
                          {plasterCementBags.toFixed(1)}
                        </strong>
                      </div>
                      <div>
                        <span className="text-muted text-[10px] uppercase font-bold block">
                          Sand Volume
                        </span>
                        <strong className="text-xl font-black text-success mt-1 block">
                          {plasterSandM3.toFixed(2)} m³
                        </strong>
                      </div>
                    </div>
                    <span className="text-[10px] text-muted italic block mt-2">
                      Includes {plasterWastage}% wastage allowance
                    </span>
                  </div>
                )}

                {/* 9. Waterproofing Results */}
                {activeCalc === "waterproofing" && (
                  <div className="space-y-4 border border-border-custom bg-input p-5 rounded-md text-center">
                    <span className="text-muted text-[10px] uppercase font-bold block">
                      Chemicals Needed
                    </span>
                    <strong className="text-3xl font-black text-success mt-2 block">
                      {wpLitres.toFixed(1)} Litres
                    </strong>
                    <span className="text-[10px] text-muted block mt-1">
                      For {wpCoats} coats with {wpWastage}% application wastage
                    </span>
                  </div>
                )}

                {/* 10. House Cost Estimator Results */}
                {activeCalc === "house_cost" && (
                  <div className="space-y-4">
                    <div className="bg-input p-4 rounded-md border border-border-custom text-center">
                      <span className="text-muted text-[10px] uppercase font-bold block">
                        Estimated Project Cost
                      </span>
                      <strong className="text-2xl font-black text-success mt-1 block">
                        ₹
                        {houseProjectCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </strong>
                      <span className="text-[9px] text-muted block mt-1">
                        Excludes {houseContingency}% contingency buffer (₹
                        {houseContingencyCost.toLocaleString(undefined, { maximumFractionDigits: 0 })})
                      </span>
                      <span className="text-[9px] text-muted block">
                        Outlay incl. buffer: ₹
                        {(houseProjectCost + houseContingencyCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                      <span className="text-[9px] text-muted italic block">
                        Indicative only: driven by the base rate you enter; not a quotation.
                      </span>
                    </div>

                    <div className="space-y-3 pt-2">
                      <h5 className="text-[10px] uppercase font-bold text-muted tracking-wider">
                        Materials & Labor Split
                      </h5>
                      {houseSplits.map((item, i) => {
                        const itemVal = houseProjectCost * item.percentage;
                        return (
                          <div key={i} className="space-y-1 text-[11px]">
                            <div className="flex justify-between text-muted">
                              <span>{item.name}</span>
                              <span className="font-semibold text-foreground">
                                ₹
                                {itemVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </span>
                            </div>
                            <div className="w-full bg-elevated h-1.5 rounded-full overflow-hidden">
                              <div
                                className={`${item.color} h-full`}
                                style={{ width: `${item.percentage * 100}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* IS-CODE / CPWD COMPLIANT CIVIL NOTE */}
          <div className="rounded-lg border border-border-custom bg-card p-6 space-y-3">
            <h4 className="text-xs font-bold text-muted uppercase tracking-widest border-b border-border-custom pb-2">
              Engineering & Takeoff Reference Notes
            </h4>
            <div className="text-[11px] text-muted space-y-1.5 leading-relaxed font-sans">
              {activeCategory === "steel" && (
                <>
                  <div>• IS 456:2000 compliant unit weight formula: Weight (kg/m) = D² ÷ 162.</div>
                  <div>• Column Main longitudinal reinforcement includes 50D lap length.</div>
                  <div>• Stirrup cutting length = closed perimeter + 2 hooks of 10D - 14d of bend deductions (four 90° corners × 2d + two 135° hooks × 3d), a net +6d.</div>
                  <div>• Slabs main reinforcement spans shorter direction; distribution steel spans longer direction.</div>
                </>
              )}
              {activeCategory === "concrete" && (
                <>
                  <div>• Dry-to-Wet volume expansion factor: 1.54 (compressibility coefficient).</div>
                  <div>• Staircase volume formula accounts for waist slab and triangular step wedges: V = Steps × Width × [ (Riser × Tread / 2) + Waist × √(Riser² + Tread²) ].</div>
                  <div>• Nominal PCC/RCC mix ratios follow IS 456. Design mixes are recommended for M30 and above.</div>
                </>
              )}
              {activeCategory === "masonry" && (
                <>
                  {activeCalc === "plaster" ? (
                    <>
                      <div>• Dry-to-Wet volume expansion factor for plaster: 1.33 (cement:sand mix, accounting for sand bulk + cement void).</div>
                      <div>• Standard plaster thickness: 12 mm internal walls, 15–20 mm external walls (per IS 1661).</div>
                      <div>• Nominal mix ratio 1:4 (cement:sand) for internal plaster; 1:6 for external plaster.</div>
                    </>
                  ) : (
                    <>
                      <div>• Modular Brick dimensions: 190 x 90 x 90 mm. Traditional Brick: 230 x 110 x 75 mm.</div>
                      <div>• Standard mortar joint thickness is 10 mm (horizontal and vertical).</div>
                      <div>• Mortar is the residual of wall volume minus net brick volume: about 19% of a modular double-leaf wall with 10 mm joints; the ~30% rule of thumb belongs to traditional brickwork.</div>
                    </>
                  )}
                </>
              )}
              {activeCategory === "finishes" && (
                <>
                  <div>• Standard door deduction is 21 sqft (3x7 ft). Window deduction is 12 sqft (3x4 ft).</div>
                  <div>• Putty rate: 2.25 kg per 100 sqft for 2 coats. Primer rate: 1L per 175 sqft.</div>
                  <div>• Paint and putty quantities include a 10% application allowance; primer a 5% allowance.</div>
                  <div>• Tile quantities account for grout width additions prior to area division.</div>
                </>
              )}
              {activeCategory === "finance" && (
                <>
                  <div>• Floor cost multipliers: Ground floor = 1.0, Floor 2 = 1.12, Floor 3 = 1.24.</div>
                  <div>• Compound wall base rate is budgeted at 35% of building base rate.</div>
                  <div>• Contingency buffer accommodates steel/cement volatility spikes.</div>
                </>
              )}
            </div>
          </div>
        </div>
        </PageShell>
      </div>
    </div>
  );
}
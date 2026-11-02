// Shared unit-of-measurement list for Indian construction. Used by any form
// that captures a material/line-item unit (Transaction line items, BOQ line
// items, Material master, Library Material/Rate presets) so the value is
// consistent across the app. Forms offer these through the shared
// <datalist id="sf-units"> in the company layout, so a unit can still be typed
// when a project measures in something not listed.
//
// Abbreviations: cft = cubic feet, cum = cubic meter, MT = metric ton,
// sqft = square feet, sqm = square meter, Rmt/Rft = running meter/feet,
// KL = kilolitre, LS = lump sum.
export const UNITS: string[] = [
  "Nos",
  "Bag",
  "kg",
  "MT",
  "tonne",
  "Quintal",
  "cum",
  "sqm",
  "Rmt",
  "Meter",
  "Kilometer",
  "cft",
  "sqft",
  "Rft",
  "Brass",
  "Liter",
  "KL",
  "Barrel",
  "Gallon",
  "Trip",
  "Load",
  "Box",
  "Bundle",
  "Coil",
  "Roll",
  "Sheet",
  "Set",
  "Pair",
  "Dozen",
  "Point",
  "Hour",
  "Day",
  "Month",
  "Job",
  "LS",
];

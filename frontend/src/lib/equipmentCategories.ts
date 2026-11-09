// Plant and machinery that goes to sites, and the company's own assets
// (laptops, phones, vehicles) that are handed to a person instead.
export const EQUIPMENT_CATEGORIES = [
  "Excavator",
  "Backhoe Loader (JCB)",
  "Hydraulic Piling Rig",
  "Tripod / Winch Piling Rig",
  "Vibro Hammer",
  "Crawler Crane",
  "Mobile Crane",
  "Tower Crane",
  "Barge / Pontoon",
  "Tug / Work Boat",
  "Concrete Mixer",
  "Transit Mixer",
  "Batching Plant",
  "Concrete Pump",
  "Wheel Loader",
  "Bulldozer",
  "Motor Grader",
  "Road Roller",
  "Paver",
  "Hot Mix Plant",
  "Dumper / Tipper",
  "Trailer",
  "Air Compressor",
  "Generator",
  "Welding Machine",
  "Survey Instrument",
  "Other",
];

export const ASSET_CATEGORIES = [
  "Laptop",
  "Desktop Computer",
  "Mobile Phone",
  "Tablet",
  "Printer / Scanner",
  "Projector",
  "Camera / CCTV",
  "Office Furniture",
  "Air Conditioner",
  "Car / Jeep",
  "Two-wheeler",
  "Other Office Asset",
];

export const isCompanyAsset = (category: string) => ASSET_CATEGORIES.includes(category);

// Useful life in years by the Companies Act 2013, Schedule II, used to fill
// a new depreciation schedule. The accountant can change it.
const LIFE_BY_CATEGORY: Record<string, number> = {
  "Laptop": 3,
  "Desktop Computer": 3,
  "Mobile Phone": 3,
  "Tablet": 3,
  "Printer / Scanner": 5,
  "Projector": 5,
  "Camera / CCTV": 5,
  "Office Furniture": 10,
  "Air Conditioner": 5,
  "Car / Jeep": 8,
  "Two-wheeler": 10,
  "Other Office Asset": 5,
};

export const usefulLifeYears = (category: string) =>
  LIFE_BY_CATEGORY[category] ?? 12; // plant and machinery used on sites

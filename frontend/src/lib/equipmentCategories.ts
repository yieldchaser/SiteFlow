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

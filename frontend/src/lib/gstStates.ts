/**
 * The GST states and union territories a project site can sit in.
 *
 * Project.state is not decoration. `POST /projects/` refuses to create a project
 * without it (projects.py: "Project.state is required for invoicing"), and
 * billing and quotation conversion refuse to run without it, because place of
 * supply derives from the site under IGST Act s.12(3). No project surface used
 * to collect the field at all, so no project could be created through the UI.
 *
 * Keep this list in step with _GST_STATE_CODE_MAP in backend/app/gst_utils.py.
 * The stored value is the name; project_state_code() lowercases and maps it.
 * Deprecated aliases in the backend map (Orissa, Puduchery, Andhra Pradesh New)
 * are intentionally not offered here.
 */
export interface GstState {
  code: string;
  name: string;
}

export const GST_STATES: GstState[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "25", name: "Daman and Diu" },
  { code: "26", name: "Dadra and Nagar Haveli" },
  { code: "27", name: "Maharashtra" },
  { code: "28", name: "Andhra Pradesh" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "38", name: "Ladakh" },
];

/** Project stage vocabulary. Free text used to fragment the Stage filter. */
export const PROJECT_STAGES = [
  "Planning",
  "Design",
  "Pre-Construction",
  "Execution",
  "Finishing",
  "Handover",
  "On Hold",
  "Completed",
] as const;

/** Project category vocabulary, for the same reason as PROJECT_STAGES. */
export const PROJECT_CATEGORIES = [
  "Residential",
  "Commercial",
  "Industrial",
  "Infrastructure",
  "Institutional",
  "Piling & Foundations",
  "Jetty & Marine Works",
  "Ports & Harbours",
  "Roads & Highways",
  "Bridges & Flyovers",
  "Metro & Railways",
  "Water & Irrigation",
  "Power & Energy",
  "Oil & Gas",
  "Warehouse & Logistics",
  "Interior Fit-out",
  "Renovation",
  "Head Office / Office",
] as const;

// Banks Indian staff are most often paid into, keyed by the first four
// letters of the IFSC so the bank can be filled in from the IFSC.
export const BANK_BY_IFSC: Record<string, string> = {
  SBIN: "State Bank of India",
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  BARB: "Bank of Baroda",
  PUNB: "Punjab National Bank",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  BKID: "Bank of India",
  IDIB: "Indian Bank",
  IOBA: "Indian Overseas Bank",
  CBIN: "Central Bank of India",
  MAHB: "Bank of Maharashtra",
  UCBA: "UCO Bank",
  PSIB: "Punjab & Sind Bank",
  KKBK: "Kotak Mahindra Bank",
  INDB: "IndusInd Bank",
  YESB: "Yes Bank",
  IDFB: "IDFC First Bank",
  IBKL: "IDBI Bank",
  FDRL: "Federal Bank",
  RATN: "RBL Bank",
  BDBL: "Bandhan Bank",
  AUBL: "AU Small Finance Bank",
  ESFB: "Equitas Small Finance Bank",
  SIBL: "South Indian Bank",
  KARB: "Karnataka Bank",
  KVBL: "Karur Vysya Bank",
  CIUB: "City Union Bank",
  TMBL: "Tamilnad Mercantile Bank",
  JAKA: "J&K Bank",
  DBSS: "DBS Bank",
  SRCB: "Saraswat Bank",
  COSB: "Cosmos Bank",
  IPOS: "India Post Payments Bank",
  AIRP: "Airtel Payments Bank",
};

export const BANKS: string[] = Object.values(BANK_BY_IFSC);

export function bankFromIfsc(ifsc: string): string | null {
  return BANK_BY_IFSC[(ifsc || "").slice(0, 4).toUpperCase()] || null;
}

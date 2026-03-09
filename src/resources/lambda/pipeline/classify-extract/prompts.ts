export const CLASSIFICATION_PROMPT = `You are a commercial real estate document classifier. Given the following OCR text from a document page, classify it into one of these categories:

- rent_roll: Tenant roster showing unit/suite, tenant name, square footage, rent amounts
- operating_statement: Income and expense statement (P&L) for a property, including hotel operating statements with revenue, expenses, NOI
- tax_return: Property tax assessment or tax return document
- appraisal: Property valuation or appraisal report
- offering_memorandum: Investment summary or marketing package for a property sale
- other: Does not fit any above category

Respond with ONLY a JSON object in this exact format:
{"documentType": "<type>", "confidence": <0.0-1.0>}

OCR Text:
{text}`;

export const EXTRACTION_PROMPTS: Record<string, string> = {
  rent_roll: `Extract structured data from this rent roll page. Return ONLY valid JSON in this format:
{
  "tenants": [{"name": "", "suite": "", "squareFeet": 0, "annualRent": 0, "leaseStart": "", "leaseEnd": ""}],
  "totalSquareFeet": 0,
  "totalAnnualRent": 0,
  "occupancyRate": 0
}
Use 0 or null for missing numeric values. Use "" for missing string values.

OCR Text:
{text}`,

  operating_statement: `Extract structured data from this operating statement. Return ONLY valid JSON in this format:
{
  "revenue": {"lineItems": [{"description": "", "amount": 0}], "total": 0},
  "expenses": {"lineItems": [{"description": "", "amount": 0}], "total": 0},
  "NOI": 0,
  "occupancy": 0,
  "ADR": 0,
  "RevPAR": 0
}
Use 0 or null for missing numeric values. ADR = Average Daily Rate, RevPAR = Revenue Per Available Room (hotel properties only).

OCR Text:
{text}`,

  tax_return: `Extract structured data from this tax document. Return ONLY valid JSON in this format:
{
  "propertyAddress": "",
  "assessedValue": {"land": 0, "improvements": 0, "total": 0},
  "annualTaxAmount": 0,
  "paymentHistory": [{"year": 0, "amount": 0, "status": ""}]
}
Use 0 or null for missing numeric values. Use "" for missing string values.

OCR Text:
{text}`,

  appraisal: `Extract structured data from this appraisal page. Return ONLY valid JSON in this format:
{
  "appraisedValue": 0,
  "capRate": 0,
  "comparableSales": [{"address": "", "salePrice": 0, "saleDate": "", "capRate": 0}]
}
Use 0 or null for missing numeric values. Use "" for missing string values.

OCR Text:
{text}`,

  offering_memorandum: `Extract structured data from this offering memorandum page. Return ONLY valid JSON in this format:
{
  "propertyName": "",
  "askingPrice": 0,
  "capRate": 0,
  "NOI": 0,
  "investmentHighlights": []
}
Use 0 or null for missing numeric values. Use "" for missing string values. investmentHighlights should be an array of strings.

OCR Text:
{text}`,
};

const XLSX = require('xlsx');
const { getSalesFileBuffer } = require('./firebaseManager');

// ── LOAD SALES DATA FROM FIREBASE STORAGE ────────────────────────────────────
async function loadSalesData() {
  try {
    const buffer = await getSalesFileBuffer();
    if (!buffer) {
      console.log('⚠️ Using empty dataset - upload sales.xlsx to Firebase Storage at data/sales.xlsx');
      return [];
    }

    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    let allRows = [];

    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      allRows = allRows.concat(rows);
    });

    console.log(`📊 Loaded ${allRows.length} rows from Excel`);
    return allRows;

  } catch (err) {
    console.error('Error loading sales data:', err);
    return [];
  }
}

// ── SUMMARIZE DATA FOR AI (keeps token count manageable) ─────────────────────
function summarizeForAI(data, maxRows = 200) {
  if (!data || data.length === 0) return 'No sales data available.';

  // Take most recent rows if too large
  const rows = data.length > maxRows ? data.slice(-maxRows) : data;

  // Build a compact summary
  let summary = `SALES DATA SUMMARY (${data.length} total invoices):\n\n`;

  // Overall totals
  const totalValue = data.reduce((sum, r) => sum + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
  const totalWithoutGST = data.reduce((sum, r) => sum + (parseFloat(r['Total Value Without GST']) || 0), 0);

  summary += `Total Sales Value (with GST): ₹${totalValue.toFixed(2)}\n`;
  summary += `Total Sales Value (without GST): ₹${totalWithoutGST.toFixed(2)}\n`;
  summary += `Total Invoices: ${data.length}\n\n`;

  // By executive
  const byExec = {};
  data.forEach(r => {
    const exec = r['Sales Executive Name'] || 'Unknown';
    if (!byExec[exec]) byExec[exec] = { count: 0, value: 0 };
    byExec[exec].count++;
    byExec[exec].value += parseFloat(r['Total Value incl VAT/GST']) || 0;
  });

  summary += `SALES BY EXECUTIVE:\n`;
  Object.entries(byExec).forEach(([name, data]) => {
    summary += `• ${name}: ${data.count} invoices, ₹${data.value.toFixed(2)}\n`;
  });

  // By district
  const byDistrict = {};
  data.forEach(r => {
    const dist = r['District Name'] || 'Unknown';
    if (!byDistrict[dist]) byDistrict[dist] = { count: 0, value: 0 };
    byDistrict[dist].count++;
    byDistrict[dist].value += parseFloat(r['Total Value incl VAT/GST']) || 0;
  });

  summary += `\nSALES BY DISTRICT:\n`;
  Object.entries(byDistrict).forEach(([name, data]) => {
    summary += `• ${name}: ${data.count} invoices, ₹${data.value.toFixed(2)}\n`;
  });

  // By product (top 10)
  const byProduct = {};
  data.forEach(r => {
    const prod = r['Product Name'] || 'Unknown';
    if (!byProduct[prod]) byProduct[prod] = { count: 0, value: 0, units: 0 };
    byProduct[prod].count++;
    byProduct[prod].value += parseFloat(r['Total Value incl VAT/GST']) || 0;
    byProduct[prod].units += parseFloat(r['Pack Size']) || 0;
  });

  const topProducts = Object.entries(byProduct)
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 10);

  summary += `\nTOP PRODUCTS BY VALUE:\n`;
  topProducts.forEach(([name, data]) => {
    summary += `• ${name}: ${data.count} invoices, ₹${data.value.toFixed(2)}\n`;
  });

  // Schemes
  const schemes = [...new Set(data.map(r => r['Scheme Discount Name']).filter(Boolean))];
  summary += `\nACTIVE SCHEMES: ${schemes.join(', ')}\n`;

  // Promo vs Non-Promo
  const promo = data.filter(r => r['Promo / Non Promo'] === 'PROMO').length;
  const nonPromo = data.filter(r => r['Promo / Non Promo'] === 'NON_PROMO').length;
  summary += `\nPROMO: ${promo} invoices | NON-PROMO: ${nonPromo} invoices\n`;

  // Raw rows (limited)
  summary += `\n\nDETAILED INVOICE ROWS (last ${rows.length}):\n`;
  summary += JSON.stringify(rows, null, 1);

  return summary;
}

module.exports = { loadSalesData, summarizeForAI };

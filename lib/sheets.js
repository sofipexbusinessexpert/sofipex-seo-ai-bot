// lib/sheets.js - Google Sheets utilities
import { google } from 'googleapis';

const {
  GOOGLE_KEY_PATH,
  GOOGLE_SHEETS_ID,
} = process.env;

export async function getAuth(scopes) {
  return new google.auth.GoogleAuth({ keyFile: GOOGLE_KEY_PATH, scopes });
}

export async function ensureHeaders(tab, headers) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ range: `${tab}!1:1`, spreadsheetId: GOOGLE_SHEETS_ID });
    const firstRow = res.data.values?.[0] || [];
    if (firstRow.join(',').trim() !== headers.join(',').trim()) {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEETS_ID, range: `${tab}!A1`, valueInputOption: "RAW", requestBody: { values: [headers] } });
      console.log(`✅ Headers corrected (UPDATE) for ${tab}`);
    } else {
      console.log(`✅ Headers already correct for ${tab}`);
    }
  } catch (err) {
    console.error(`❌ Headers setup error for ${tab}:`, err.message);
  }
}

export async function saveToSheets(tab, values) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SHEETS_ID, range: `${tab}!A:A`, valueInputOption: "RAW", requestBody: { values: [values] } });
    console.log(`✅ Sheets ${tab}: Data appended`);
  } catch (err) {
    console.error(`❌ Sheets ${tab} error:`, err.message);
  }
}

export async function appendManyToSheets(tab, rows) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    if (!rows || rows.length === 0) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A:A`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  } catch (err) {
    console.error(`❌ Sheets batch append error for ${tab}:`, err.message);
  }
}

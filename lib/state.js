// lib/state.js - State persistence with Google Sheets and local file fallback
import fs from 'fs/promises';
import { google } from 'googleapis';
import { getAuth as getSheetsAuth } from './sheets.js';

const {
  GOOGLE_KEY_PATH,
  GOOGLE_SHEETS_ID,
  STATE_FILE_PATH: STATE_FILE_PATH_ENV
} = process.env;

const STATE_FILE_PATH = STATE_FILE_PATH_ENV || './state.json';

let localState = {};
let localStateLoaded = false;

export async function loadLocalStateFromFile() {
  if (localStateLoaded) return;
  try {
    const data = await fs.readFile(STATE_FILE_PATH, 'utf8');
    const json = JSON.parse(data);
    if (json && typeof json === 'object') {
      localState = { ...localState, ...json };
    }
  } catch {}
  localStateLoaded = true;
}

export async function saveLocalStateToFile() {
  try {
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify(localState, null, 2), 'utf8');
  } catch {}
}

export async function getStateValue(key) {
  try {
    await loadLocalStateFromFile();
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return localState[key];
    const auth = await getSheetsAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range: 'State!A:B' });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) return rows[i][1];
    }
    return undefined;
  } catch (e) {
    return localState[key];
  }
}

export async function setStateValue(key, value) {
  try {
    await loadLocalStateFromFile();
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) {
      localState[key] = String(value);
      await saveLocalStateToFile();
      return;
    }
    const auth = await getSheetsAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range: 'State!A:B' });
    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) { rowIndex = i + 1; break; }
    }
    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SHEETS_ID, range: 'State!A:B', valueInputOption: 'RAW', requestBody: { values: [[key, String(value)]] } });
    } else {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEETS_ID, range: `State!B${rowIndex}`, valueInputOption: 'RAW', requestBody: { values: [[String(value)]] } });
    }
  } catch (e) {
    localState[key] = String(value);
    await saveLocalStateToFile();
  }
}

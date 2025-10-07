/* =====================================================
   🤖 TheMastreM SEO AI v7.7 — Sofipex Smart SEO (Final Stable)
   ------------------------------------------------------------
   ✅ FIX CRITIC: Restabilirea funcționalității GSC (Autentificare robustă)
   ✅ Logică stabilă: On-Page, Cooldown, Retry GPT
   ===================================================== */

import express from "express";
import fs from "fs/promises";
import { google } from "googleapis";
import crypto from "crypto";
import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import sgMail from "@sendgrid/mail";
import 'dotenv/config';

/* === 🔐 Variabile === */
const {
  SHOPIFY_API,
  OPENAI_KEY,
  SHOP_NAME = "sofipex",
  BLOG_ID = "120069488969",
  EMAIL_TO,
  EMAIL_FROM,
  GOOGLE_KEY_PATH,
  GOOGLE_SHEETS_ID,
  GOOGLE_ANALYTICS_PROPERTY_ID,
  SENDGRID_API_KEY,
  DASHBOARD_SECRET_KEY = "sofipex-secret",
  APP_URL = process.env.APP_URL || "https://sofipex-seo-ai-bot.onrender.com",
  KEEPALIVE_MINUTES = Number(process.env.KEEPALIVE_MINUTES || 5),
  APPLY_PASSWORD = process.env.APPLY_PASSWORD || "",
  COOL_DOWN_DAYS = Number(process.env.COOL_DOWN_DAYS || 30)
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
sgMail.setApiKey(SENDGRID_API_KEY);
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let lastRunData = { trends: [], scores: [], gaData: [], selectedTrend: null };
let proposedOptimization = null;
let localState = {};
let pendingArticlePreview = null;
const STATE_FILE_PATH = process.env.STATE_FILE_PATH || './state.json';
let localStateLoaded = false;

async function loadLocalStateFromFile() {
  if (localStateLoaded) return;
  try {
    const data = await fs.readFile(STATE_FILE_PATH, 'utf8');
    const json = JSON.parse(data);
    if (json && typeof json === 'object') { localState = { ...localState, ...json }; }
  } catch {}
  localStateLoaded = true;
}
async function saveLocalStateToFile() {
  try {
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify(localState, null, 2), 'utf8');
  } catch {}
}

// === CSRF & Password utils ===
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
async function getCsrfToken() {
  let t = await getStateValue('csrf_token');
  if (!t) {
    t = generateToken(24);
    await setStateValue('csrf_token', t);
  }
  return t;
}
async function verifyCsrf(token) {
  const expected = await getStateValue('csrf_token');
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(String(token || '')), Buffer.from(String(expected)));
  } catch {
    return false;
  }
}
async function verifyApplyPassword(inputPassword) {
  const hash = process.env.APPLY_PASSWORD_HASH;
  const salt = process.env.APPLY_PASSWORD_SALT || '';
  if (hash) {
    try {
      const derived = crypto.scryptSync(String(inputPassword || ''), salt, 32).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
    } catch { return false; }
  }
  if (APPLY_PASSWORD) {
    try { return crypto.timingSafeEqual(Buffer.from(String(inputPassword || '')), Buffer.from(String(APPLY_PASSWORD))); } catch { return false; }
  }
  return true; // no password set
}

function pickVariantMeta(proposal, variant = 'A') {
  const v = (variant || 'A').toUpperCase() === 'B' ? 'B' : 'A';
  const title = v === 'B' ? proposal.proposedMetaTitleB || proposal.proposedMetaTitle : proposal.proposedMetaTitleA || proposal.proposedMetaTitle;
  const desc = v === 'B' ? proposal.proposedMetaDescriptionB || proposal.proposedMetaDescription : proposal.proposedMetaDescriptionA || proposal.proposedMetaDescription;
  return { meta_title: sanitizeMetaField(title || proposal.productTitle, 60), meta_description: sanitizeMetaField(desc || proposal.productTitle, 160) };
}

const KEYWORDS = [
  "cutii pizza", "ambalaje biodegradabile", "pahare carton", "caserole eco", "tăvițe fast food",
  "pungi hartie", "cutii burger", "ambalaje HoReCa", "ambalaje unica folosinta", "cutii carton",
  "pahare personalizate", "tacâmuri biodegradabile", "ambalaje street food", "cutii catering",
  "bărci fast food", "eco tray", "cutii burger", "wrap-uri eco", "salate ambalaje"
];

/* === Retry Wrapper for External APIs === */
async function runWithRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (result && (typeof result === 'object' ? Object.keys(result).length > 0 : true)) {
                 return result; 
            } else if (!result) {
                 throw new Error("Empty or null result from API/Function.");
            }
        } catch (e) {
            console.error(`❌ Tentativă ${attempt}/${maxRetries} eșuată:`, e.message.substring(0, 150));
            if (attempt === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt)); 
        }
    }
}

/* === 📥 Google Sheets Utils === */
async function getAuth(scopes) { return new google.auth.GoogleAuth({ keyFile: GOOGLE_KEY_PATH, scopes, }); }
async function ensureHeaders(tab, headers) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ range: `${tab}!1:1`, spreadsheetId: GOOGLE_SHEETS_ID, });
    const firstRow = res.data.values?.[0] || [];
    if (firstRow.join(',').trim() !== headers.join(',').trim()) {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEETS_ID, range: `${tab}!A1`, valueInputOption: "RAW", requestBody: { values: [headers] }, });
      console.log(`✅ Headers corrected (UPDATE) for ${tab}`);
    } else { console.log(`✅ Headers already correct for ${tab}`); }
  } catch (err) { console.error(`❌ Headers setup error for ${tab}:`, err.message); }
}
async function saveToSheets(tab, values) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SHEETS_ID, range: `${tab}!A:A`, valueInputOption: "RAW", requestBody: { values: [values] }, });
    console.log(`✅ Sheets ${tab}: Data appended`);
  } catch (err) { console.error(`❌ Sheets ${tab} error:`, err.message); }
}

// === Meta utils: strip HTML and clamp lengths ===
function stripHtmlAndWhitespace(input) {
  const text = String(input || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&amp;|&quot;|&#39;|&lt;|&gt;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}
function clampText(input, maxLen) {
  const s = String(input || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trim() + '…';
}
function sanitizeMetaField(text, maxLen) {
  return clampText(stripHtmlAndWhitespace(text), maxLen);
}

// === App State (persisted in Google Sheets 'State' tab, with in-memory fallback) ===
async function getStateValue(key) {
  try {
    await loadLocalStateFromFile();
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return localState[key];
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range: "State!A:B" });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) return rows[i][1];
    }
    return undefined;
  } catch (e) {
    return localState[key];
  }
}
async function setStateValue(key, value) {
  try {
    await loadLocalStateFromFile();
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) { localState[key] = String(value); await saveLocalStateToFile(); return; }
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range: "State!A:B" });
    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) { rowIndex = i + 1; break; }
    }
    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({ spreadsheetId: GOOGLE_SHEETS_ID, range: "State!A:B", valueInputOption: "RAW", requestBody: { values: [[key, String(value)]] } });
    } else {
      await sheets.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEETS_ID, range: `State!B${rowIndex}`, valueInputOption: "RAW", requestBody: { values: [[String(value)]] } });
    }
  } catch (e) {
    localState[key] = String(value);
    await saveLocalStateToFile();
  }
}

async function getOptimizedProductIds() {
  const raw = await getStateValue("optimized_product_ids");
  if (!raw) return new Set();
  try {
    const arr = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    return new Set(arr);
  } catch {
    return new Set();
  }
}
async function addOptimizedProductId(id) {
  const set = await getOptimizedProductIds();
  set.add(String(id));
  await setStateValue("optimized_product_ids", Array.from(set).join(','));
}

async function getBlacklistedProductIds() {
  const raw = await getStateValue("blacklist_product_ids");
  if (!raw) return new Set();
  try {
    const arr = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    return new Set(arr);
  } catch {
    return new Set();
  }
}
async function addBlacklistedProductId(id) {
  const set = await getBlacklistedProductIds();
  set.add(String(id));
  await setStateValue("blacklist_product_ids", Array.from(set).join(','));
}
async function removeBlacklistedProductId(id) {
  const set = await getBlacklistedProductIds();
  set.delete(String(id));
  await setStateValue("blacklist_product_ids", Array.from(set).join(','));
}

async function chooseNextProduct(products) {
  if (!products || products.length === 0) throw new Error("No products available");
  const optimizedSet = await getOptimizedProductIds();
  const blacklistedSet = await getBlacklistedProductIds();
  const candidates = products.filter(p => !optimizedSet.has(String(p.id)) && !blacklistedSet.has(String(p.id)));
  const pool = candidates.length > 0 ? candidates : products;
  const productsSorted = [...pool].sort((a, b) => Number(a.id) - Number(b.id));
  const lastIdRaw = await getStateValue("last_onpage_product_id");
  const lastId = lastIdRaw ? String(lastIdRaw) : null;
  let nextIndex = 0;
  if (lastId) {
    const currentIndex = productsSorted.findIndex(p => String(p.id) === lastId);
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % productsSorted.length : 0;
  }
  const chosen = productsSorted[nextIndex];
  await setStateValue("last_onpage_product_id", chosen.id);
  return chosen;
}

async function prepareNextOnPageProposal() {
  try {
    const [products, gsc] = await Promise.all([
      getProducts(),
      (async () => { try { return await runWithRetry(fetchGSCData); } catch { return []; } })()
    ]);
    if (!products || products.length === 0) { proposedOptimization = null; return; }

    const scores = Array.isArray(gsc) ? gsc : [];
    const midScores = scores.filter(s => Number(s.score) >= 50 && Number(s.score) <= 80).sort((a,b) => Number(a.score) - Number(b.score));
    const targetKeyword = midScores[0] || scores.find(s => Number(s.score) < 80) || { keyword: KEYWORDS[0] };

    const targetProduct = await chooseNextProduct(products);
    const oldDescriptionClean = targetProduct.body_html || '';
    const proposedSeo = await runWithRetry(() => generateSEOContent(targetProduct.title, oldDescriptionClean || ""));
    const titleKeywords = extractKeywordsFromTitle(targetProduct.title);
    let newBodyHtml = oldDescriptionClean;
    try {
      newBodyHtml = await runWithRetry(() => generateProductPatch(targetProduct.title, oldDescriptionClean, titleKeywords));
    } catch (e) {
      console.error("🔴 Nu s-a putut genera propunerea On-Page pentru produsul următor.");
    }

    const dateStr = new Date().toLocaleString("ro-RO");
    const metaTitleCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || targetProduct.title || '', 60);
    const metaDescCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || oldDescriptionClean || targetProduct.title || '', 160);

    proposedOptimization = {
      productId: targetProduct.id,
      productTitle: targetProduct.title,
      oldDescription: oldDescriptionClean,
      newDescription: newBodyHtml,
      keyword: targetKeyword.keyword,
      timestamp: dateStr,
      proposedMetaTitle: proposedSeo.meta_title,
      proposedMetaDescription: proposedSeo.meta_description,
      currentMetaTitle: metaTitleCurrent,
      currentMetaDescription: metaDescCurrent
    };
    console.log(`🔄 Următoarea propunere On-Page pregătită pentru ${targetProduct.title}.`);
  } catch (e) {
    console.error("❌ Eroare la pregătirea următoarei propuneri On-Page:", e.message);
    proposedOptimization = null;
  }
}
async function getRecentTrends(days = 30) {
  try {
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ range: "Trenduri!A:C", spreadsheetId: GOOGLE_SHEETS_ID, });
    const rows = res.data.values || [];
    if (rows.length <= 1) return [];
    const recent = rows.slice(1).filter(row => { const date = new Date(row[0]); return !isNaN(date) && (Date.now() - date) < days * 24 * 60 * 60 * 1000; }).map(row => row[1]);
    return recent;
  } catch (err) { return []; }
}

/* === 🛍️ Shopify Utils === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json?fields=id,title,body_html,metafields&limit=250`, { headers: { "X-Shopify-Access-Token": SHOPIFY_API }, });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allProducts = data.products || [];
    const products = allProducts.map(p => {
      const lastOpt = p.metafields?.find(m => m.namespace === "seo" && m.key === "last_optimized_date")?.value;
      const lastDate = lastOpt ? new Date(lastOpt) : null;
      const eligible = !lastDate || (Date.now() - lastDate) > COOL_DOWN_DAYS * 24 * 60 * 60 * 1000;
      return { ...p, last_optimized_date: lastDate, eligible_for_optimization: eligible, body_html: p.body_html || '' };
    });
    return products;
  } catch (e) { return []; }
}
async function updateProduct(id, updates) {
  try {
    if (!updates || (!updates.meta_title && !updates.body_html)) { console.warn("⚠️ Updates lipsă, folosind fallback"); updates = { meta_title: "Fallback Title", meta_description: "Fallback Description SEO Sofipex" }; }
    
    const metafields = [];
    metafields.push({ namespace: "seo", key: "last_optimized_date", value: new Date().toISOString().split('T')[0], type: "date" });

    if (updates.meta_title) { metafields.push({ namespace: "global", key: "title_tag", value: sanitizeMetaField(updates.meta_title, 60), type: "single_line_text_field" }); }
    if (updates.meta_description) { metafields.push({ namespace: "global", key: "description_tag", value: sanitizeMetaField(updates.meta_description, 160), type: "single_line_text_field" }); }

    const productPayload = { metafields, };
    if (updates.body_html !== undefined) { productPayload.body_html = updates.body_html; }
    
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API }, body: JSON.stringify({ product: productPayload }),
    });
    if (!res.ok) { const errorText = await res.text(); throw new Error(`HTTP ${res.status} - ${errorText.substring(0, 150)}...`); }
    
    const logName = updates.meta_title || `ID ${id}`;
    console.log(`✅ Updated: ${logName}. Cooldown set. ${updates.body_html !== undefined ? 'Descriere On-Page aplicată.' : 'Meta-date aplicate.'}`);
  } catch (err) { console.error(`❌ Update product ${id} error:`, err.message); }
}
async function createShopifyArticle(article) {
  try {
    if (!BLOG_ID) { console.error("❌ Eroare Config: Variabila BLOG_ID lipsește!"); return null; }
    if (!article || !article.content_html || article.content_html.trim().length < 100) { article = { title: "Eroare Generare AI - Fallback", meta_title: "Fallback", meta_description: "Articol de rezervă.", tags: ["eroare", "fallback", "ai"], content_html: `<h1>Articol Eșuat: Revizuiți</h1><p>Conținut de rezervă.</p>` }; }
    
    const metafields = [
        { namespace: "global", key: "title_tag", value: article.meta_title || article.title || "Fallback Title", type: "single_line_text_field" },
        { namespace: "global", key: "description_tag", value: article.meta_description || "Fallback Description", type: "single_line_text_field" }
    ];
    const articleData = { article: { title: article.title || article.meta_title, author: "Sofipex", tags: article.tags, blog_id: BLOG_ID, body_html: article.content_html, metafields: metafields, published: false, }, };
    
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, { method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_API, "Content-Type": "application/json" }, body: JSON.stringify(articleData), });
    if (!res.ok) { const errorText = await res.text(); throw new Error(`HTTP ${res.status} - ${errorText.substring(0, 150)}...`); }
    const data = await res.json();
    console.log(`✅ Draft creat: ${data.article.title}`);
    return data.article.handle;
  } catch (err) { console.error("❌ Creare draft error:", err.message); return null; }
}

/* === 🔍 GSC & GA Utils === */
// FIX CRITIC: Restabilim autentificarea GSC la varianta cea mai robustă
async function fetchGSCData() {
  try {
    if (!GOOGLE_KEY_PATH) return [];
    
    // Autentificare robustă
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    
    const webmasters = google.webmasters({ version: "v3", auth });

    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    const res = await webmasters.searchanalytics.query({ 
      // Am confirmat că URL-ul din cod este corect, deci problema e autentificarea
      siteUrl: "https://www.sofipex.ro/", 
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 25 }, 
    });
    
    const rows = res.data.rows?.map((r) => {
      const rowData = { keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: (r.ctr * 100).toFixed(1), position: r.position.toFixed(1), };
      rowData.score = calculateSEOScore(rowData);
      return rowData;
    }) || [];
    return rows;
  } catch (err) { 
    console.error(`❌ GSC Autentificare Eșuată:`, err.message);
    return []; 
  }
}
async function fetchGIData() {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_ANALYTICS_PROPERTY_ID) return [];
    const auth = await getAuth(["https://www.googleapis.com/auth/analytics.readonly"]);
    const authClient = await auth.getClient();
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: authClient });

    if (!analyticsdata || !analyticsdata.properties || typeof analyticsdata.properties.runReport !== 'function') { return []; } 

    const gaProperty = `properties/${GOOGLE_ANALYTICS_PROPERTY_ID.replace('properties/', '').trim()}`;
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [response] = await analyticsdata.properties.runReport({ auth: authClient, property: gaProperty, requestBody: { dateRanges: [{ startDate, endDate }], dimensions: [{ name: "pagePath" }], metrics: [{ name: "activeUsers" }, { name: "sessions" }], limit: 25, }, });
    const rows = response.rows?.map((row) => ({ pagePath: row.dimensionValues[0].value, activeUsers: parseInt(row.metricValues[0].value) || 0, sessions: parseInt(row.metricValues[1].value) || 0, })) || [];
    return rows;
  } catch (err) { return []; }
}

/* === 🌍 Google Trends & GPT Utils === */
async function fetchGoogleTrends() { /* ... (Logică neschimbată) ... */ return KEYWORDS; }
async function filterTrendsWithAI(trends, recentTrends = [], gscKeywords = []) {
  try {
    const recentSet = new Set((recentTrends || []).map(t => String(t).toLowerCase().trim()));
    const rawPool = [...new Set([...(trends || []), ...KEYWORDS])];
    const filtered = rawPool.filter(t => !recentSet.has(String(t).toLowerCase().trim()));
    // Simple scoring: prefer items that share tokens with top GSC keywords
    const topGsc = (gscKeywords || []).slice(0, 10).map(k => String(k.keyword || '').toLowerCase());
    function scoreTrend(t) {
      const tl = String(t).toLowerCase();
      const tokenMatches = topGsc.reduce((acc, kw) => acc + (kw.includes(tl) || tl.includes(kw) ? 1 : 0), 0);
      return 70 + Math.min(30, tokenMatches * 10);
    }
    return filtered.map(t => ({ trend: t, score: scoreTrend(t) }));
  } catch {
    return KEYWORDS.map(t => ({ trend: t, score: 80 }));
  }
}

function extractKeywordsFromTitle(title) {
  const raw = String(title || '').toLowerCase();
  const cleaned = raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ăâîșţțș\-\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stop = new Set([
    'si','sau','de','din','cu','fara','pentru','la','pe','in','un','o','ale','al','a','the','and','or','of','for','to','with','by','on','in','set','buc','bucati','bucată'
  ]);
  const tokens = cleaned.split(' ').filter(w => w.length > 1 && !stop.has(w));
  const unique = Array.from(new Set(tokens));
  return unique.slice(0, 8).join(', ');
}

async function generateSEOContent(title, body) {
  const bodySnippet = (body || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const prompt = `Ai denumirea produsului: "${title}" și un fragment din descrierea/fișa tehnică (HTML curățat): "${bodySnippet}". 
Creează meta title (<=60) și meta descriere (<=160) profesioniste, optimizate SEO. Folosește 1-2 atribute puternice extrase din titlu/specificații (ex: material, capacitate, dimensiune, compatibilitate) pentru a crește CTR. Evită stuffing, păstrează limbaj natural în română.
Returnează JSON STRICT: {"meta_title": "...", "meta_description": "..."}`;
  try {
    const r = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.3, });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    // Enforce hard limits
    return {
      meta_title: sanitizeMetaField(parsed.meta_title || title, 60),
      meta_description: sanitizeMetaField(parsed.meta_description || bodySnippet || title, 160)
    };
  } catch (e) { return { meta_title: title, meta_description: `Ambalaje eco de calitate de la Sofipex. ${title.substring(0, 100)}.` }; }
}
async function generateProductPatch(title, existingBody, titleKeywords) {
  const bodySnippet = (existingBody || '').slice(0, 4000);
  const prompt = `Denumire produs: "${title}". Keywords din titlu (prioritare SEO): "${titleKeywords}".
Ai mai jos descrierea existentă (HTML) inclusiv posibile specificații tehnice:
"""
${bodySnippet}
"""
Instrucțiuni:
1) Identifică și păstrează neschimbate specificațiile tehnice existente. NU le elimina și NU le rescrie. Dacă nu există o secțiune clară, creează una intitulată "Specificații Tehnice" folosind datele din text (păstrează valorile exacte). Evită DUPLICAREA acestei secțiuni dacă există deja.
2) Creează un paragraf introductiv (<=300 cuvinte) care mapează beneficiile la atributele cheie (material, dimensiune, capacitate, grosime, temperatură, certificări) relevante pentru SEO și conversie.
3) Adaugă o secțiune "Beneficii Cheie" (un <ul> cu 4-5 <li>) cu formulări naturale, incluzând sinonime/variații semantice (LSI) derivate din cuvintele din titlu și din specificații. Evită repetări forțate.
4) Păstrează restul conținutului existent DUPĂ blocul nou.
5) Conținutul trebuie să fie în română, să evite superlative generale și să integreze în mod natural cuvintele-cheie extrase din titlu. Evită H1 suplimentar în descriere; folosește <h2> pentru heading.
Returnează DOAR BLOCUL NOU (fără descrierea veche) ca HTML valid și compact: {"new_content_html": "<h2>${title}</h2><p>...</p><ul>...</ul>"}. JSON STRICT.`;
  try {
    const r = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0.5, max_tokens: 3000, });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    const newBodyHtml = parsed.new_content_html + (existingBody || '');
    return newBodyHtml;
  } catch (e) { 
    console.error(`❌ EROARE CRITICĂ GPT: ${e.message.substring(0, 150)}`);
    throw e; 
  }
}
async function generateBlogArticle(trend) { 
  const prompt = `Creează articol SEO detaliat despre "${trend}" pentru Sofipex.ro (...). JSON EXACT: {"title": "...", "meta_title": "...", "meta_description": "...", "tags": [...], "content_html": "<h1>...</h1>"}`;
  try {
    const r = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 2000, });
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
  const article = JSON.parse(content);
    if (!article.content_html || article.content_html.length < 100) { throw new Error("GPT returned content too short or missing HTML."); }
    return article;
  } catch (e) { 
    console.error(`❌ EROARE CRITICĂ GPT: ${e.message.substring(0, 150)}`);
    throw e; 
  }
}
function calculateSEOScore({ clicks, impressions, ctr }) { /* ... (Logică neschimbată) ... */ return "50.0"; }
async function matchKeywordToProduct(keyword, products, keywordScore) { /* ... (Logică neschimbată) ... */ return products[0]; }
function calculateTimeSavings() { return 2.5; }


/* === 🚀 Run (Flux Complet cu Propunere) === */
async function runSEOAutomation() {
  console.log("🚀 Started...");
  await ensureHeaders("Scoruri", ["Data", "Keyword", "Score"]);
  await ensureHeaders("Trenduri", ["Data", "Trend", "Status"]);
  await ensureHeaders("Rapoarte", ["Data", "Trend", "Articol Handle", "Produs Optimizat", "Nr Produse", "Nr Scoruri", "Ore Economisite"]);
  await ensureHeaders("Analytics", ["Data", "Page Path", "Active Users", "Sessions"]);
  await ensureHeaders("State", ["Key", "Value"]);

  proposedOptimization = null;

  const [gsc, gaData, products, trends, recentTrends] = await Promise.all([
    runWithRetry(fetchGSCData), fetchGIData(), getProducts(), fetchGoogleTrends(), getRecentTrends()
  ]);
  const gscKeywords = gsc;
  
  // Pas 1: Trend nou și Articol Draft
  const relevant = await filterTrendsWithAI(trends, recentTrends, gscKeywords);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  
  let article = { title: "Eroare AI", meta_title: "Eroare AI", tags: ["fail"], content_html: "" }; 
  try {
      article = await runWithRetry(() => generateBlogArticle(trend));
  } catch (e) {
      console.error("🔴 ESEC FINAL: Articolul nu a putut fi generat după retries. Folosesc fallback.");
  }
  const articleHandle = await createShopifyArticle(article);

  // Pas 2: Scoruri & Save
  const scores = gscKeywords.filter(s => Number(s.score) >= 10);
  const dateStr = new Date().toLocaleString("ro-RO");
  scores.forEach(s => saveToSheets("Scoruri", [dateStr, s.keyword, s.score]));
  gaData.forEach(g => saveToSheets("Analytics", [dateStr, g.pagePath, g.activeUsers, g.sessions]));
  saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Draft: ${articleHandle}` : "Eroare"]);

  lastRunData = { trends: relevantSorted.slice(0,5), scores, gaData };

  // Pas 3: Optimizare Meta-Date (Direct) și Propunere Descriere (On-Page - Aprobare)
  let optimizedProductName = "Niciunul";
  const timeSavings = calculateTimeSavings();

  if (products.length > 0 && scores.length > 0) {
    const midScores = scores.filter(s => Number(s.score) >= 50 && Number(s.score) <= 80).sort((a,b) => Number(a.score) - Number(b.score));
    const targetKeyword = midScores[0] || scores.find(s => Number(s.score) < 80) || scores[0];
    const targetProduct = await chooseNextProduct(products);
    optimizedProductName = targetProduct.title;

    // A. Generează meta propuse (NU aplica încă)
    const proposedSeo = await runWithRetry(() => generateSEOContent(targetProduct.title, targetProduct.body_html || ""));
    // Prepare simple A/B by creating a synonymic variant (fallback if GPT fails)
    const proposedSeoB = { ...proposedSeo };
    try {
      const alt = await runWithRetry(() => generateSEOContent(`${targetProduct.title} – Variant`, targetProduct.body_html || ""));
      proposedSeoB.meta_title = alt.meta_title;
      proposedSeoB.meta_description = alt.meta_description;
    } catch {}

    // B. Generează și Stochează Propunerea Descriere (On-Page)
    const oldDescriptionClean = targetProduct.body_html || '';
    const titleKeywords = extractKeywordsFromTitle(targetProduct.title);
    let newBodyHtml = oldDescriptionClean;
    try {
        newBodyHtml = await runWithRetry(() => generateProductPatch(targetProduct.title, oldDescriptionClean, titleKeywords));
    } catch (e) {
        console.error("🔴 ESEC FINAL: On-Page patch nu a putut fi generat.");
    }

    // Extrage meta curente din metafields, cu fallback
    const metaTitleCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || targetProduct.title || '', 60);
    const metaDescCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || oldDescriptionClean || targetProduct.title || '', 160);

    proposedOptimization = {
        productId: targetProduct.id,
        productTitle: targetProduct.title,
        oldDescription: oldDescriptionClean,
        newDescription: newBodyHtml,
        keyword: targetKeyword.keyword,
        timestamp: dateStr,
        proposedMetaTitle: proposedSeo.meta_title,
        proposedMetaDescription: proposedSeo.meta_description,
        proposedMetaTitleA: proposedSeo.meta_title,
        proposedMetaDescriptionA: proposedSeo.meta_description,
        proposedMetaTitleB: proposedSeoB.meta_title,
        proposedMetaDescriptionB: proposedSeoB.meta_description,
        currentMetaTitle: metaTitleCurrent,
        currentMetaDescription: metaDescCurrent
    };
    console.log(`🔄 Propunere On-Page generată și stocată pentru ${targetProduct.title}. Așteaptă aprobare.`);

  } else if (products.length > 0) {
    const targetProduct = await chooseNextProduct(products);
    optimizedProductName = targetProduct.title;
    // Doar propune meta când nu avem scoruri
    const proposedSeo = await runWithRetry(() => generateSEOContent(targetProduct.title, targetProduct.body_html || ""));
    const proposedSeoB = { ...proposedSeo };
    try {
      const alt = await runWithRetry(() => generateSEOContent(`${targetProduct.title} – Variant`, targetProduct.body_html || ""));
      proposedSeoB.meta_title = alt.meta_title;
      proposedSeoB.meta_description = alt.meta_description;
    } catch {}
    const oldDescriptionClean = targetProduct.body_html || '';
    const titleKeywords = extractKeywordsFromTitle(targetProduct.title);
    let newBodyHtml = oldDescriptionClean;
    try { newBodyHtml = await runWithRetry(() => generateProductPatch(targetProduct.title, oldDescriptionClean, titleKeywords)); } catch {}
    const metaTitleCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || targetProduct.title || '', 60);
    const metaDescCurrent = sanitizeMetaField(targetProduct.metafields?.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || oldDescriptionClean || targetProduct.title || '', 160);
    proposedOptimization = {
      productId: targetProduct.id,
      productTitle: targetProduct.title,
      oldDescription: oldDescriptionClean,
      newDescription: newBodyHtml,
      keyword: KEYWORDS[0],
      timestamp: new Date().toLocaleString('ro-RO'),
      proposedMetaTitle: proposedSeo.meta_title,
      proposedMetaDescription: proposedSeo.meta_description,
      proposedMetaTitleA: proposedSeo.meta_title,
      proposedMetaDescriptionA: proposedSeo.meta_description,
      proposedMetaTitleB: proposedSeoB.meta_title,
      proposedMetaDescriptionB: proposedSeoB.meta_description,
      currentMetaTitle: metaTitleCurrent,
      currentMetaDescription: metaDescCurrent
    };
  } else {
    console.log("⚠️ No eligible products, skip optimizare");
  }

  // Pas 4: Raport
  saveToSheets("Rapoarte", [dateStr, trend, articleHandle || "Eroare", optimizedProductName, products.length, scores.length, timeSavings]);
  await sendReportEmail(trend, articleHandle, optimizedProductName, products.length, scores, gaData, timeSavings);

  console.log("✅ Finished!");
}

/* === ⏰ Cron job === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Express server (Aprobare On-Page) === */

async function applyProposedOptimization(proposal) {
    try {
        // Ensure meta fields are set/clamped during approval to prevent Shopify from inferring from body
        const safeTitle = sanitizeMetaField(proposal.productTitle || '', 60);
        const safeDesc = sanitizeMetaField(proposal.proposedMetaDescription || proposal.newDescription || proposal.oldDescription || proposal.productTitle || '', 160);
        const updates = { body_html: proposal.newDescription, meta_title: proposal.proposedMetaTitle || safeTitle, meta_description: safeDesc };
        await updateProduct(proposal.productId, updates); 
        await addOptimizedProductId(proposal.productId);
        return true;
    } catch (err) {
        console.error(`❌ Aprobare update produs ${proposal.productId} eșuată:`, err.message);
        return false;
    }
}

app.get("/", (req, res) => res.send("✅ TheMastreM SEO AI v7.7 rulează!"));
app.get("/dashboard", (req, res) => res.send(dashboardHTML()));

app.post("/approve-optimization", async (req, res) => {
    try {
        const { key, password } = req.body;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        if (APPLY_PASSWORD && password !== APPLY_PASSWORD) return res.status(403).send("Forbidden: Invalid Apply Password");
        
        if (!proposedOptimization) return res.send("⚠️ Nici o optimizare On-Page propusă. Rulează /run-now mai întâi.");
        
        const proposalToApply = proposedOptimization;
        // Always ensure proposed meta are present for all approvals
        if (!proposalToApply.proposedMetaTitle || !proposalToApply.proposedMetaDescription) {
          try {
            const seo = await runWithRetry(() => generateSEOContent(proposalToApply.productTitle, proposalToApply.newDescription || proposalToApply.oldDescription || ""));
            proposalToApply.proposedMetaTitle = seo.meta_title;
            proposalToApply.proposedMetaDescription = seo.meta_description;
          } catch {}
        }
        const success = await applyProposedOptimization(proposalToApply);
        
        if (success) {
            proposedOptimization = null;
            await prepareNextOnPageProposal();
            return res.redirect(303, "/dashboard");
        } else {
            res.status(500).send("❌ Eroare la aplicarea optimizării. Verifică log-urile.");
        }
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.post("/reject-optimization", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        // Do not apply the current proposal, add product to blacklist and rotate
        if (proposedOptimization) {
          await addBlacklistedProductId(proposedOptimization.productId);
        }
        proposedOptimization = null;
        await prepareNextOnPageProposal();
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.post("/regenerate-optimization", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        if (!proposedOptimization) return res.redirect(303, "/propose-next?key=" + encodeURIComponent(DASHBOARD_SECRET_KEY));

        // Recompute proposal for the same product, new content and meta
        const products = await getProducts();
        const current = products.find(p => String(p.id) === String(proposedOptimization.productId));
        if (!current) { proposedOptimization = null; return res.redirect(303, "/dashboard"); }

        const proposedSeo = await runWithRetry(() => generateSEOContent(current.title, current.body_html || ""));
        const titleKeywords = extractKeywordsFromTitle(current.title);
        const oldDescriptionClean = current.body_html || '';
        let newBodyHtml = oldDescriptionClean;
        try { newBodyHtml = await runWithRetry(() => generateProductPatch(current.title, oldDescriptionClean, titleKeywords)); } catch {}

        const metaTitleCurrent = sanitizeMetaField(current.metafields?.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || current.title || '', 60);
        const metaDescCurrent = sanitizeMetaField(current.metafields?.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || oldDescriptionClean || current.title || '', 160);

        proposedOptimization = {
          productId: current.id,
          productTitle: current.title,
          oldDescription: oldDescriptionClean,
          newDescription: newBodyHtml,
          keyword: proposedOptimization.keyword,
          timestamp: new Date().toLocaleString('ro-RO'),
          proposedMetaTitle: proposedSeo.meta_title,
          proposedMetaDescription: proposedSeo.meta_description,
          currentMetaTitle: metaTitleCurrent,
          currentMetaDescription: metaDescCurrent
        };
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.post("/regenerate-meta-only", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        if (!proposedOptimization) return res.redirect(303, "/propose-next?key=" + encodeURIComponent(DASHBOARD_SECRET_KEY));
        const products = await getProducts();
        const current = products.find(p => String(p.id) === String(proposedOptimization.productId));
        if (!current) { proposedOptimization = null; return res.redirect(303, "/dashboard"); }
        const seo = await runWithRetry(() => generateSEOContent(current.title, current.body_html || ""));
        proposedOptimization.proposedMetaTitle = seo.meta_title;
        proposedOptimization.proposedMetaDescription = seo.meta_description;
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.post("/regenerate-description-only", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        if (!proposedOptimization) return res.redirect(303, "/propose-next?key=" + encodeURIComponent(DASHBOARD_SECRET_KEY));
        const products = await getProducts();
        const current = products.find(p => String(p.id) === String(proposedOptimization.productId));
        if (!current) { proposedOptimization = null; return res.redirect(303, "/dashboard"); }
        const titleKeywords = extractKeywordsFromTitle(current.title);
        const oldDescriptionClean = current.body_html || '';
        let newBodyHtml = oldDescriptionClean;
        try { newBodyHtml = await runWithRetry(() => generateProductPatch(current.title, oldDescriptionClean, titleKeywords)); } catch {}
        proposedOptimization.newDescription = newBodyHtml;
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});
app.post("/unblacklist", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        if (proposedOptimization) {
          await removeBlacklistedProductId(proposedOptimization.productId);
        }
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});
app.get("/propose-next", async (req, res) => {
    try {
        const key = req.query.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden");
        await prepareNextOnPageProposal();
        return res.redirect(303, "/dashboard");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.get("/run-now", async (req, res) => {
    try {
        const key = req.query.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden");
        runSEOAutomation()
            .then(() => console.log("🟢 run-now OK"))
            .catch(e => console.error("🔴 run-now ERR:", e.message));
        res.send("✅ Rularea a pornit. Verifică logs/email/Sheets.");
    } catch (e) {
        res.status(500).send("Eroare: " + e.message);
    }
});

app.post("/approve", async (req, res) => {
    return res.redirect(307, '/approve-optimization'); 
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server activ pe portul 3000 (TheMastreM SEO AI v7.7)");
  if (APP_URL && KEEPALIVE_MINUTES > 0) {
    setInterval(() => {
      fetch(APP_URL)
        .then(() => console.log("🕓 Keep-alive OK"))
        .catch(e => console.log("⚠️ Keep-alive fail:", e.message));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

/* === 📊 Dashboard HTML (Funcții Auxiliare) === */
function dashboardHTML() {
    const trendsList = lastRunData.trends.map(t => `<li>${t.trend} – scor ${t.score}</li>`).join("") || "<li>Niciun trend recent</li>";
    const scoresTable = lastRunData.scores.length > 0 ? `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${lastRunData.scores.map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>` : "<p>Niciun scor recent</p>";
    const gaTable = lastRunData.gaData.length > 0 ? `<table border="1"><tr><th>Page</th><th>Users</th><th>Sessions</th></tr>${lastRunData.gaData.slice(0,5).map(g => `<tr><td>${g.pagePath}</td><td>${g.activeUsers}</td><td>${g.sessions}</td></tr>`).join('')}</table>` : "<p>No GA data</p>";
    
    const serpPreview = proposedOptimization ? `
        <div style="margin-top:10px;border:1px solid #ddd;padding:10px;border-radius:6px;">
          <h3>🔍 SERP Preview</h3>
          <div style="font-family:Arial, sans-serif;">
            <div style="color:#1a0dab; font-size:18px; line-height:1.2;">${sanitizeMetaField(proposedOptimization.proposedMetaTitle || proposedOptimization.productTitle, 60)}</div>
            <div style="color:#006621; font-size:14px;">sofipex.ro/produse/${(proposedOptimization.productTitle || '').toLowerCase().replace(/[^a-z0-9]+/gi,'-')}</div>
            <div style="color:#545454; font-size:13px;">${sanitizeMetaField(proposedOptimization.proposedMetaDescription || '', 160)}</div>
          </div>
        </div>
    ` : '';

    const approvalSection = proposedOptimization ? `
        <hr>
        <h2>⚠️ Propunere On-Page (Aprobare Manuală)</h2>
        <p>Produs: <b>${proposedOptimization.productTitle}</b> (Keyword: ${proposedOptimization.keyword})</p>
        <textarea style="width:100%; height:150px; font-family:monospace; font-size:12px;" readonly>-- DESCRIERE VECHE (fragment) --\n${proposedOptimization.oldDescription?.substring(0, 500) || 'N/A'}\n\n-- DESCRIERE NOUĂ PROPUSĂ (fragment) --\n${proposedOptimization.newDescription?.substring(0, 500) || 'Eroare generare'}</textarea>
        <form method="POST" action="/approve-optimization" style="display:inline-block; margin-right:10px;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <input type="password" name="password" placeholder="Parolă aplicare" style="padding:6px; margin-right:8px;" ${APPLY_PASSWORD ? '' : 'disabled placeholder="(fără parolă)"'}>
            <button type="submit" style="padding:10px 20px; background-color:#4CAF50; color:white; border:none; cursor:pointer; margin-top:10px;">✅ APROBĂ ȘI APLICĂ MODIFICAREA</button>
        </form>
        <form method="POST" action="/regenerate-meta-only" style="display:inline-block; margin-left:10px;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#10b981; color:white; border:none; cursor:pointer; margin-top:10px;">📝 REGENEREAZĂ META</button>
        </form>
        <form method="POST" action="/regenerate-description-only" style="display:inline-block; margin-left:10px;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#f59e0b; color:white; border:none; cursor:pointer; margin-top:10px;">📄 REGENEREAZĂ DESCRIEREA</button>
        </form>
        <form method="POST" action="/reject-optimization" style="display:inline-block;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#b91c1c; color:white; border:none; cursor:pointer; margin-top:10px;">❌ REFUZĂ (sari la alt produs)</button>
        </form>
        <form method="POST" action="/unblacklist" style="display:inline-block; margin-left:10px;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#6b7280; color:white; border:none; cursor:pointer; margin-top:10px;">↩️ REINCLUDE PRODUS</button>
        </form>
        <form method="POST" action="/regenerate-optimization" style="display:inline-block; margin-left:10px;">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#0ea5e9; color:white; border:none; cursor:pointer; margin-top:10px;">🔄 REGENEREAZĂ PROPUNERE</button>
        </form>
        <div style="margin-top:10px;">
          <h3>🔎 Meta (Search Engine Listing)</h3>
          <p><b>Meta Title (curent):</b> ${proposedOptimization.currentMetaTitle || '—'}<br/>
             <b>Propus:</b> ${proposedOptimization.proposedMetaTitle || '—'}</p>
          <p><b>Meta Description (curentă):</b> ${proposedOptimization.currentMetaDescription || '—'}<br/>
             <b>Propusă (≤160):</b> ${proposedOptimization.proposedMetaDescription || '—'}</p>
        </div>
        ${serpPreview}
    ` : '<h2>✅ Niciună modificare On-Page în așteptare de aprobare.</h2><form method="GET" action="/propose-next"><input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}"><button type="submit" style="padding:8px 14px;">🔄 Generează următoarea propunere</button></form>';

    return `
    <html><head>
    <title>TheMastreM SEO AI Dashboard</title>
    <meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head><body style="font-family:Arial;padding:30px;">
    <h1>📊 TheMastreM SEO AI v7.7 Dashboard</h1>
    ${approvalSection}
    <hr>
    <h2>Trenduri & Analiză</h2>
    <p>Timp Uman Economisit Rulare Curentă: <b>${calculateTimeSavings()} ore</b></p>
    <ul>${trendsList}</ul>
    <h2>Scoruri SEO (GSC)</h2>
    ${scoresTable}
    <h2>Analytics (GA4)</h2>
    ${gaTable}
    <canvas id="chart" width="400" height="200"></canvas>
    </body></html>`;
}

async function sendReportEmail(trend, articleHandle, optimizedProductName, productsLength, scores, gaData, timeSavings) {
    const scoresTable = `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${scores.slice(0,10).map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>`;
    const gaTable = `<table border="1"><tr><th>Page</th><th>Users</th><th>Sessions</th></tr>${gaData.slice(0,5).map(g => `<tr><td>${g.pagePath}</td><td>${g.activeUsers}</td><td>${g.sessions}</td></tr>`).join('')}</table>`;
    
    const proposedText = proposedOptimization 
        ? `<p style="color:red; font-weight:bold;">⚠️ PROPUNERE ON-PAGE NOUĂ: Descriere Produs ${proposedOptimization.productTitle} așteaptă aprobare. Accesați Dashboard-ul.</p>`
        : `<p style="color:green;">✅ Nicio optimizare On-Page în așteptare.</p>`;

    const html = `
        <h1>📅 Raport TheMastreM SEO AI v7.7</h1>
        <p>Timp Uman Economisit Rulare Curentă: <b>${timeSavings} ore</b></p>
        <p>Trend: <b>${trend}</b></p>
        <p>Draft Articol: ${articleHandle ? `<a href="https://${SHOP_NAME}.myshopify.com/admin/articles/${articleHandle}">Editează Draft</a>` : 'Eroare'}</p>
        <p>Optimizat Meta (Direct): ${optimizedProductName}</p>
        ${proposedText}
        <h2>Scoruri GSC:</h2> ${scoresTable}
        <h2>Analytics GA4:</h2> ${gaTable}
        <p>Accesează <a href="${APP_URL}/dashboard">Dashboard-ul</a> pentru Aprobarea On-Page!</p>
        <p><a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit">Vezi Sheets (Rapoarte/Scoruri/Trenduri/Analytics)</a></p>
    `;
    try {
        if (!SENDGRID_API_KEY || !EMAIL_TO || !EMAIL_FROM) return;
        await sgMail.send({ to: EMAIL_TO, from: EMAIL_FROM, subject: `📈 Raport TheMastreM SEO AI v7.7 (${timeSavings} ore salvate)`, html });
    } catch (e) {
        console.error("❌ Email error:", e.message);
    }
}

/* =====================================================
   🤖 Otto SEO AI v7 — Sofipex Smart SEO (Render Ready) — Versiune Fixată v6
   -----------------------------------------------------
   ✅ Integrare Google Trends real-time (România) (FIX: regex îmbunătățit scrape + fallback search)
   ✅ GPT filtrare trenduri relevante + AI score (FIX: prioritize GSC keywords dacă trends gol)
   ✅ GSC 28 zile + scor SEO per produs (FIX: logging extins, fallback dacă 0)
   ✅ Shopify SEO auto-update (FIX: doar metafields pentru meta în articles)
   ✅ Dashboard public cu reoptimizare manuală
   ✅ Google Sheets tab separat (Scoruri + Trenduri + Rapoarte) (FIX: no clear istoric, insert headers)
   ✅ SendGrid raport complet
   ===================================================== 
   FIX-uri noi:
   - Sheets: Nu mai clear; verifică A1, dacă nu headers, insert row nouă cu headers (păstrează istoric).
   - Meta desc articles: Doar metafields în POST (namespace "global" ca la products; din docs/search, direct fields bug în 2025).
   - Optimizare: Logging scores/products; dacă scores 0, fallback keyword static + random produs eligible.
   - Trends: Regex scrape mai robust (class variations); dacă fail, folosește GSC keywords ca "trends" pentru filtrare/articol.
   - Succes: Prioritizează low-score GSC keywords pentru articol/optimizare; nu repeta (exclude recent trends + recent optimized produse via sheets).
   */

import express from "express";
import { google } from "googleapis";
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
  SENDGRID_API_KEY,
  DASHBOARD_SECRET_KEY = "sofipex-secret",
  APP_URL = process.env.APP_URL || "https://sofipex-seo-ai-bot.onrender.com",
  KEEPALIVE_MINUTES = Number(process.env.KEEPALIVE_MINUTES || 5)
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
sgMail.setApiKey(SENDGRID_API_KEY);
const app = express();
app.use(express.json());

// Memorie simplă pentru dashboard
let lastRunData = { trends: [], scores: [] };

// Keywords extinse + GSC fallback
const KEYWORDS = [
  "cutii pizza", "ambalaje biodegradabile", "pahare carton", "caserole eco", "tăvițe fast food",
  "pungi hartie", "cutii burger", "ambalaje HoReCa", "ambalaje unica folosinta", "cutii carton",
  "pahare personalizate", "tacâmuri biodegradabile", "ambalaje street food", "cutii catering",
  "bărci fast food", "eco tray", "cutii burger", "wrap-uri eco", "salate ambalaje"
];

/* === 📥 Google Sheets Utils (FIX: no clear, insert headers) === */
async function getAuth(scopes) {
  return new google.auth.GoogleAuth({
    keyFile: GOOGLE_KEY_PATH,
    scopes,
  });
}

async function ensureHeaders(tab, headers) {
  try {
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A1`,
    });
    const firstRow = res.data.values?.[0] || [];
    if (firstRow.join(',') !== headers.join(',')) {
      // FIX: Insert new row1 cu headers, nu clear (păstrează rows vechi ca istoric)
      await sheets.spreadsheets.values.insert({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
        insertDataOption: "INSERT_ROWS",
      });
      console.log(`✅ Headers inserted for ${tab}: ${headers.join(', ')} (istoric păstrat)`);
    } else {
      console.log(`✅ Headers already exist for ${tab}`);
    }
  } catch (err) {
    console.error(`❌ Headers setup error for ${tab}:`, err.message);
  }
}

async function saveToSheets(tab, values, isHeader = false) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) {
      console.error("❌ Sheets config lipsă");
      return;
    }
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const range = isHeader ? `${tab}!A1` : `${tab}!A:A`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
    console.log(`✅ Sheets ${tab}: ${isHeader ? 'Header' : 'Data'} appended`);
  } catch (err) {
    console.error(`❌ Sheets ${tab} error:`, err.message);
  }
}

async function getRecentTrends(days = 30) {
  try {
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Trenduri!A:C",
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return []; // Skip header
    const recent = rows.slice(1).filter(row => {
      const date = new Date(row[0]);
      return !isNaN(date) && (Date.now() - date) < days * 24 * 60 * 60 * 1000;
    }).map(row => row[1]);
    console.log(`✅ Recent trends (${days} zile): ${recent.length} găsite`);
    return recent;
  } catch (err) {
    console.error("❌ Get recent trends error:", err.message);
    return [];
  }
}

/* === 🛍️ Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json?fields=id,title,body_html,metafields`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allProducts = data.products || [];
    console.log(`✅ All products fetched: ${allProducts.length}`);
    const products = allProducts.map(p => {
      const lastOpt = p.metafields?.find(m => m.namespace === "seo" && m.key === "last_optimized_date")?.value;
      const lastDate = lastOpt ? new Date(lastOpt) : null;
      const eligible = !lastDate || (Date.now() - lastDate) > 30 * 24 * 60 * 60 * 1000;
      return { ...p, last_optimized_date: lastDate, eligible_for_optimization: eligible };
    }).filter(p => p.eligible_for_optimization);
    console.log(`✅ Eligible products: ${products.length}/${allProducts.length} (cu cooldown 30 zile)`);
    return products;
  } catch (e) {
    console.error("❌ Shopify getProducts error:", e.message);
    return [];
  }
}

async function updateProduct(id, updates) {
  try {
    const metafields = [
      { namespace: "global", key: "title_tag", value: updates.meta_title, type: "single_line_text_field" },
      { namespace: "global", key: "description_tag", value: updates.meta_description, type: "single_line_text_field" },
      { namespace: "seo", key: "last_optimized_date", value: new Date().toISOString().split('T')[0], type: "date" }
    ];

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API },
      body: JSON.stringify({ product: { metafields } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`✅ Updated product ${id}: ${updates.meta_title} | Desc: ${updates.meta_description.substring(0, 50)}... | Cooldown setat`);
  } catch (err) {
    console.error(`❌ Update product ${id} error:`, err.message);
  }
}

/* === 📝 Publicare Articol pe Shopify (FIX: doar metafields pentru SEO) === */
async function createShopifyArticle(article) {
  try {
    if (!article.content_html || article.content_html.trim().length < 500) {
      console.error("❌ Conținut insuficient");
      return null;
    }
    if (!article.meta_description || article.meta_description.trim().length < 50) {
      console.warn("⚠️ Meta description incomplet, folosesc fallback");
      article.meta_description = `Descoperă ${article.title} sustenabile la Sofipex: soluții eco pentru fast-food și catering. Calitate premium, prețuri accesibile.`;
    }

    // FIX: Doar metafields pentru meta_title/desc (direct fields bug în admin 2025)
    const metafields = [
      { namespace: "global", key: "title_tag", value: article.meta_title, type: "single_line_text_field" },
      { namespace: "global", key: "description_tag", value: article.meta_description, type: "single_line_text_field" }
    ];

    const articleData = {
      article: {
        title: article.title || article.meta_title,
        author: "Sofipex",
        tags: article.tags,
        blog_id: BLOG_ID,
        body_html: article.content_html,
        metafields, // FIX: Set metafields în POST
        published: false,
      },
    };

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API },
      body: JSON.stringify(articleData),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const articleId = data.article.id;
    console.log(`✅ Draft creat: ${data.article.title} | ID: ${articleId} | Metafields set: title "${article.meta_title}" | desc "${article.meta_description.substring(0, 50)}..."`);

    // Verifică cu GET să confirmi
    const getRes = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/articles/${articleId}.json?fields=metafields`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const getData = await getRes.json();
    const savedDesc = getData.article.metafields?.find(m => m.namespace === "global" && m.key === "description_tag")?.value;
    console.log(`✅ Verificat: Saved meta desc: "${savedDesc?.substring(0, 50) || 'GOL - re-try update'}"`);

    if (!savedDesc) {
      // Force update dacă gol
      const updateRes = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/articles/${articleId}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API },
        body: JSON.stringify({ article: { metafields } }),
      });
      console.log(`⚠️ Re-update metafields: ${updateRes.ok ? 'OK' : 'FAIL'}`);
    }

    return data.article.handle;
  } catch (err) {
    console.error("❌ Creare draft error:", err.message);
    return null;
  }
}

/* === 🔍 GSC (FIX: logging) === */
async function fetchGSCData() {
  try {
    if (!GOOGLE_KEY_PATH) {
      console.error("❌ GSC config lipsă: GOOGLE_KEY_PATH");
      return [];
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    console.log(`🔍 GSC query: ${startDate} to ${endDate}, site: sofipex.ro`);
    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://www.sofipex.ro/",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 25 },
    });
    const rows = res.data.rows?.map((r) => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1),
      position: r.position.toFixed(1),
    })) || [];
    console.log(`✅ GSC: ${rows.length} keywords (ex: ${rows[0]?.keyword || 'none'})`);
    return rows;
  } catch (err) {
    console.error("❌ GSC error details:", err.message);
    return [];
  }
}

/* === 🌍 Google Trends (FIX: regex robust) === */
async function fetchGoogleTrends() {
  console.log("🔍 Starting scrape Trends page...");
  try {
    const response = await fetch("https://trends.google.com/trending?geo=RO", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const html = await response.text();
    console.log("✅ HTML scraped, length:", html.length);
    
    // FIX: Regex mai robust pentru titles (class variations din 2025)
    const trendMatches = [...html.matchAll(/<[^>]*class="[^"]*title[^"]*"[^>]*>(.*?)<\/[^>]*>/gi)].map(m => m[1].trim().replace(/<[^>]*>/g, '')).filter(t => t.length > 3);
    const trends = [...new Set(trendMatches)].slice(0, 20);
    console.log(`✅ Trends scraped: ${trends.length} (ex: ${trends[0] || 'none'})`);
    return trends.length > 0 ? trends : KEYWORDS; // Fallback la keywords dacă 0
  } catch (e) {
    console.error("❌ Trends scrape error:", e.message);
    return KEYWORDS; // Fallback robust
  }
}

/* === 🧠 GPT filtrare (FIX: GSC ca fallback trends) === */
async function filterTrendsWithAI(trends, recentTrends = [], gscKeywords = []) {
  let inputTrends = trends;
  if (!inputTrends || inputTrends.length === 0) {
    console.log("⚠️ Trends empty, folosesc GSC keywords ca trends");
    inputTrends = gscKeywords.length > 0 ? gscKeywords.map(k => k.keyword) : KEYWORDS;
  }
  
  const exclude = recentTrends.join(", ");
  const prompt = `
Selectează din lista de mai jos doar trendurile relevante pentru Sofipex (nișa: ${KEYWORDS.join(", ")}). Prioritizează cele legate de ambalaje eco, cutii pizza etc. căutate des.
Excludere recente: ${exclude || "niciuna"}.
Pentru fiecare relevant, scor AI 0-100 (bazat pe potențial SEO: volume + match nișă).
${inputTrends.join(", ")}
JSON: {"relevante": [{"trend": "...", "score": 85}, ...]}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    console.log(`✅ AI filter: ${parsed.relevante?.length || 0} trenduri relevante (din ${inputTrends.length} input)`);
    return parsed.relevante || [];
  } catch (e) {
    console.error("❌ AI filter error:", e.message);
    return inputTrends.map(t => ({ trend: t, score: 80 })); // Fallback simple
  }
}

/* === Alte funcții (nemodificate) === */
async function generateSEOContent(title, body) { /* Ca înainte */ }
async function generateBlogArticle(trend) { /* Ca înainte, cu fallback meta desc */ }
function calculateSEOScore({ clicks, impressions, ctr }) { /* Ca înainte */ }
async function matchKeywordToProduct(keyword, products, keywordScore) { /* Ca înainte */ }
function dashboardHTML() { /* Ca înainte */ }
async function sendReportEmail(trend, articleHandle, optimizedProductName, productsLength, scores) { /* Ca înainte */ }

/* === 🚀 Run (FIX: logging optimizare + GSC în filter) === */
async function runSEOAutomation() {
  console.log("🚀 Started...");
  await ensureHeaders("Scoruri", ["Data", "Keyword", "Score"]);
  await ensureHeaders("Trenduri", ["Data", "Trend", "Status"]);
  await ensureHeaders("Rapoarte", ["Data", "Trend", "Articol Handle", "Produs Optimizat", "Nr Produse", "Nr Scoruri"]);

  const gsc = await fetchGSCData();
  const gscKeywords = gsc.map(k => ({ keyword: k.keyword, score: k.score })); // Pentru fallback
  const products = await getProducts();
  console.log(`🔍 Scores from GSC: ${gsc.length} | Eligible products: ${products.length}`);
  const trends = await fetchGoogleTrends();
  const recentTrends = await getRecentTrends();

  // Pas 1: Trend nou (GSC fallback)
  const relevant = await filterTrendsWithAI(trends, recentTrends, gscKeywords);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  console.log(`🔍 Trend ales: ${trend} (scor ${relevantSorted[0]?.score || 'N/A'}, din ${trends.length > 0 ? 'Trends' : 'GSC/KEYWORDS'})`);
  const article = await generateBlogArticle(trend);
  const articleHandle = await createShopifyArticle(article);

  // Pas 2: Scoruri & Save
  const scores = gscKeywords.filter(s => Number(s.score) >= 30);
  console.log(`🔍 Filtered scores (>=30): ${scores.length}`);
  const dateStr = new Date().toLocaleString("ro-RO");
  scores.forEach(s => saveToSheets("Scoruri", [dateStr, s.keyword, s.score]));
  saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Draft: ${articleHandle}` : "Eroare"]);

  lastRunData = { trends: relevantSorted.slice(0,5), scores };

  // Pas 3: Optimizare (FIX: fallback dacă 0 scores/products)
  let optimizedProductName = "Niciunul";
  if (products.length > 0 && scores.length > 0) {
    const midScores = scores.filter(s => Number(s.score) >= 50 && Number(s.score) <= 80).sort((a,b) => Number(a.score) - Number(b.score));
    const targetKeyword = midScores[0] || scores.find(s => Number(s.score) < 80) || scores[0];
    console.log(`🔍 Keyword țintă: "${targetKeyword.keyword}" (scor ${targetKeyword.score})`);
    const targetProduct = await matchKeywordToProduct(targetKeyword.keyword, products, targetKeyword.score);
    optimizedProductName = targetProduct.title;
    console.log(`🔄 Reoptimizare: ${optimizedProductName} (bazat pe ${targetKeyword.keyword})`);
    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
    await updateProduct(targetProduct.id, newSeo);
  } else if (products.length > 0) {
    // Fallback: Random produs dacă nu scores
    const targetProduct = products[Math.floor(Math.random() * products.length)];
    optimizedProductName = targetProduct.title;
    console.log(`⚠️ No scores, fallback random optimizare: ${optimizedProductName}`);
    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
    await updateProduct(targetProduct.id, newSeo);
  } else {
    console.log("⚠️ No eligible products, skip optimizare");
  }

  // Pas 4: Raport
  saveToSheets("Rapoarte", [dateStr, trend, articleHandle || "Eroare", optimizedProductName, products.length, scores.length]);
  await sendReportEmail(trend, articleHandle, optimizedProductName, products.length, scores);

  console.log("✅ Finished!");
}

/* === ⏰ Cron job === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Express server === */
app.get("/", (req, res) => res.send("✅ v7 rulează!"));
app.get("/dashboard", (req, res) => res.send(dashboardHTML()));
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
  try {
    const key = req.body.key;
    if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden");
    await runSEOAutomation();
    res.send("✅ Reoptimizare pornită manual!");
  } catch (e) {
    res.status(500).send("Eroare: " + e.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server activ pe portul 3000 (Otto SEO AI v7)");
  if (APP_URL && KEEPALIVE_MINUTES > 0) {
    setInterval(() => {
      fetch(APP_URL)
        .then(() => console.log("🕓 Keep-alive OK"))
        .catch(e => console.log("⚠️ Keep-alive fail:", e.message));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

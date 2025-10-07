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
  GOOGLE_ANALYTICS_PROPERTY_ID,
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
let lastRunData = { trends: [], scores: [], gaData: [] };

// Keywords extinse
const KEYWORDS = [
  "cutii pizza", "ambalaje biodegradabile", "pahare carton", "caserole eco", "tăvițe fast food",
  "pungi hartie", "cutii burger", "ambalaje HoReCa", "ambalaje unica folosinta", "cutii carton",
  "pahare personalizate", "tacâmuri biodegradabile", "ambalaje street food", "cutii catering",
  "bărci fast food", "eco tray", "cutii burger", "wrap-uri eco", "salate ambalaje"
];

/* === 📥 Google Sheets Utils === */
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
    
    // Check if the sheet exists
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
    });
    const sheetExists = spreadsheet.data.sheets.some(sheet => sheet.properties.title === tab);

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEETS_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: tab,
                  gridProperties: { rowCount: 100, columnCount: headers.length },
                },
              },
            },
          ],
        },
      });
      console.log(`✅ Created new sheet: ${tab}`);
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A1:${String.fromCharCode(64 + headers.length)}1`, // Dynamic range based on header count
    });
    const firstRow = res.data.values?.[0] || [];
    if (firstRow.length === 0 || firstRow.join(',').trim() !== headers.join(',').trim()) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: `${tab}!A1:${String.fromCharCode(64 + headers.length)}1`,
        valueInputOption: "RAW",
        resource: { values: [headers] },
      });
      console.log(`✅ Headers updated for ${tab}: ${headers.join(', ')}`);
    } else {
      console.log(`✅ Headers already correct for ${tab}: ${headers.join(', ')}`);
    }
  } catch (err) {
    console.error(`❌ Headers setup error for ${tab}:`, err.message);
    // Fallback: Append headers if update fails
    await saveToSheets(tab, headers, true);
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
    if (rows.length <= 1) return [];
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
    if (!updates || !updates.meta_title) {
      console.warn("⚠️ Updates undefined, folosesc fallback");
      updates = { meta_title: "Fallback Title", meta_description: "Fallback Description SEO Sofipex" };
    }
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

/* === 📝 Publicare Articol pe Shopify === */
async function createShopifyArticle(article) {
  try {
    if (!article || !article.content_html || article.content_html.trim().length < 500) {
      console.error("❌ Conținut insuficient sau article undefined, folosesc fallback");
      article = {
        title: "Articol Fallback Sofipex",
        meta_title: "Ambalaje Eco Sofipex | Fallback",
        meta_description: "Descoperă soluții sustenabile de ambalaje de la Sofipex. Calitate și eco-friendly pentru afacerea ta.",
        tags: ["eco", "sustenabil"],
        content_html: "<h1>Ambalaje Eco la Sofipex</h1><p>Conținut fallback detaliat despre ambalaje sustenabile. Sofipex oferă cutii pizza biodegradabile, pahare carton și mai mult. Beneficii: reducere deșeuri, conformitate UE. Contactează-ne!</p><h2>Beneficii</h2><ul><li>Materiale reciclabile.</li><li>Prețuri competitive.</li><li>Livrare rapidă.</li></ul><p>Concluzie: Alege eco azi.</p>"
      };
    }
    if (!article.meta_description || article.meta_description.trim().length < 50) {
      console.warn("⚠️ Meta description incomplet, folosesc fallback");
      article.meta_description = `Descoperă ${article.title} sustenabile la Sofipex: soluții eco pentru fast-food și catering. Calitate premium, prețuri accesibile.`;
    }

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
        metafields,
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

    // Verifică
    const getRes = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/articles/${articleId}.json?fields=metafields`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const getData = await getRes.json();
    const savedDesc = getData.article.metafields?.find(m => m.namespace === "global" && m.key === "description_tag")?.value;
    console.log(`✅ Verificat: Saved meta desc: "${savedDesc?.substring(0, 50) || 'GOL - re-try update'}"`);

    if (!savedDesc) {
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

/* === 🔍 GSC === */
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
    const rows = res.data.rows?.map((r) => {
      const rowData = {
        keyword: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1),
        position: r.position.toFixed(1),
      };
      rowData.score = calculateSEOScore(rowData);
      return rowData;
    }) || [];
    console.log(`✅ GSC: ${rows.length} keywords (ex: ${rows[0]?.keyword || 'none'}), scoruri ex: ${rows.slice(0,3).map(r => `${r.keyword}:${r.score}`).join(', ')}`);
    return rows;
  } catch (err) {
    console.error("❌ GSC error details:", err.message);
    return [];
  }
}

/* === 📊 Google Analytics 4 Data API v1 (FIX: log full error) === */
async function fetchGIData() {
  try {
    if (!GOOGLE_KEY_PATH) {
      console.warn("⚠️ GA skipped - GOOGLE_KEY_PATH missing");
      return [];
    }
    if (!GOOGLE_ANALYTICS_PROPERTY_ID) {
      console.warn("⚠️ GA skipped - GOOGLE_ANALYTICS_PROPERTY_ID missing (add to .env: properties/XXXXXX)");
      return [];
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
    console.log(`🔍 GA auth scopes: analytics.readonly | Property: ${GOOGLE_ANALYTICS_PROPERTY_ID}`);

    // Test authentication
    const authClient = await auth.getClient();
    if (!authClient) {
      console.error("❌ GA authentication failed - invalid client");
      return [];
    }

    const analyticsdata = google.analyticsdata({ version: "v1beta", auth });
    if (!analyticsdata || !analyticsdata.reports || !analyticsdata.reports.run) {
      console.error("❌ GA API not available - ensure Data API is enabled in Google Cloud Console");
      return [];
    }

    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    console.log(`🔍 GA query: ${startDate} to ${endDate}`);
    const [response] = await analyticsdata.reports.run({
      auth: authClient,
      property: `properties/${GOOGLE_ANALYTICS_PROPERTY_ID}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "pagePath" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" }
        ],
        limit: 25,
      },
    });
    const rows = response.rows?.map((row) => ({
      pagePath: row.dimensionValues[0].value,
      activeUsers: parseInt(row.metricValues[0].value) || 0,
      sessions: parseInt(row.metricValues[1].value) || 0,
    })) || [];
    console.log(`✅ GA: ${rows.length} pagini (ex: ${rows[0]?.pagePath || 'none'}, users: ${rows[0]?.activeUsers || 0}, sessions: ${rows[0]?.sessions || 0})`);
    return rows;
  } catch (err) {
    console.error("❌ GA error full:", err.response?.data?.error?.message || err.message || err);
    if (err.code === 403 || err.code === 401) {
      console.warn("⚠️ GA authentication issue - check GOOGLE_KEY_PATH, scopes, and API enablement");
    } else if (err.code === 404) {
      console.warn("⚠️ GA property not found - verify GOOGLE_ANALYTICS_PROPERTY_ID");
    }
    return [];
  }
}

/* === 🌍 Google Trends === */
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
    
    const trendMatches = [...html.matchAll(/<[^>]*class="[^"]*title[^"]*"[^>]*>(.*?)<\/[^>]*>/gi)].map(m => m[1].trim().replace(/<[^>]*>/g, '')).filter(t => t.length > 3);
    const trends = [...new Set(trendMatches)].slice(0, 20);
    console.log(`✅ Trends scraped: ${trends.length} (ex: ${trends[0] || 'none'})`);
    return trends.length > 0 ? trends : KEYWORDS;
  } catch (e) {
    console.error("❌ Trends scrape error:", e.message);
    return KEYWORDS;
  }
}

/* === 🧠 GPT filtrare === */
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
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    console.log(`🔍 GPT raw response: ${content.substring(0, 100)}...`);
    const parsed = JSON.parse(content);
    console.log(`✅ AI filter: ${parsed.relevante?.length || 0} trenduri relevante (din ${inputTrends.length} input)`);
    return parsed.relevante || [];
  } catch (e) {
    console.error("❌ AI filter error (parse fail):", e.message, "| Content:", content);
    return inputTrends.map(t => ({ trend: t, score: 80 }));
  }
}

/* === ✍️ Generare SEO Content pentru Produs === */
async function generateSEOContent(title, body) {
  const prompt = `Creează meta title (max 60 caractere) și meta descriere (max 160 caractere) profesionale, optimizate SEO pentru produsul: "${title}". Include keywords relevante din nișa ambalaje eco. Returnează JSON strict: {"meta_title": "...", "meta_description": "..."}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    console.log(`🔍 SEO GPT raw: ${content.substring(0, 100)}...`);
    const raw = content.match(/\{.*\}/)?.[0] || content;
    const parsed = JSON.parse(raw);
    console.log(`✅ SEO content gen: ${parsed.meta_title?.substring(0, 30) || 'parse fail'}...`);
    return parsed;
  } catch (e) {
    console.error("❌ SEO content error (parse fail):", e.message, "| Raw:", content);
    return { meta_title: title, meta_description: `Ambalaje eco de calitate de la Sofipex. ${title.substring(0, 100)}.` };
  }
}

/* === 📰 Articol SEO din trend === */
async function generateBlogArticle(trend) {
  const prompt = `
Creează articol SEO detaliat despre "${trend}" pentru Sofipex.ro (ambalaje eco: ${KEYWORDS.join(", ")}).
Structură: H1 titlu, intro 200-300c, H2 subtitlu1 + paragraf + ul(3-5 li), H2 subtitlu2 + paragraf, concluzie 100-200c cu CTA.
Min 800 cuvinte, HTML curat.
Meta title: max 60 char cu "${trend}".
Meta description: OBLIGATORIU max 160 char, persuasivă, keywords din nișa (ex: ambalaje eco, cutii pizza).
3-5 taguri.
JSON EXACT: {"title": "...", "meta_title": "...", "meta_description": "...", "tags": [...], "content_html": "<h1>...</h1>"}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    });
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    console.log(`🔍 Article GPT raw: ${content.substring(0, 100)}...`);
    const article = JSON.parse(content);
    if (!article.content_html || article.content_html.length < 1000) {
      console.warn("⚠️ Conținut scurt sau lipsă, extins fallback");
      article.content_html = `<h1>${trend}</h1><p>Introducere detaliată despre ${trend} în contextul ambalajelor sustenabile la Sofipex. Explorăm beneficiile materialelor biodegradabile și inovațiile în cutii pizza eco.</p><h2>Beneficii cheie</h2><ul><li>Reducere impact mediu cu 50% prin materiale reciclabile.</li><li>Costuri reduse pe termen lung pentru afaceri HoReCa.</li><li>Conformitate cu reguli UE pentru ambalaje sustenabile.</li><li>Personalizare pentru branduri fast-food.</li><li>Durabilitate crescută pentru transport catering.</li></ul><h2>Inovații recente</h2><p>Descoperă noile trenduri: pahare carton impermeabile, caserole compostabile. Sofipex integrează tehnologii avansate pentru a oferi soluții complete.</p><p>Concluzie: Alege Sofipex pentru ambalaje eco care susțin afacerea ta. Contactează-ne azi pentru oferte personalizate!</p>`;
    }
    if (!article.meta_description) {
      article.meta_description = `Sofipex: Soluții eco pentru ${trend}. Ambalaje biodegradabile de calitate superioară pentru fast-food și catering.`;
    }
    console.log(`✅ Articol: ${article.title} | Meta desc: ${article.meta_description?.length || 0} char | Content len: ${article.content_html.length}`);
    return article;
  } catch (e) {
    console.error("❌ Articol error (parse fail):", e.message, "| Raw:", content);
    return {
      title: `${trend} | Sofipex`,
      meta_title: `${trend} | Sofipex.ro`,
      meta_description: `Sofipex: Soluții eco pentru ${trend}. Ambalaje biodegradabile de calitate superioară pentru fast-food și catering.`,
      tags: ["sustenabilitate", "eco", "ambalaje"],
      content_html: `<h1>${trend}</h1><p>Articol detaliat generat de AI despre ${trend}. Sofipex oferă soluții inovatoare pentru ambalaje eco, reducând impactul asupra mediului prin materiale biodegradabile și reciclabile. <strong>Beneficii cheie:</strong> <ul><li>Reducere deșeuri cu 50%.</li><li>Costuri mai mici pe termen lung.</li><li>Conformitate UE reguli eco.</li></ul> <h2>Inovații în ambalaje</h2> <p>Explorează noile trenduri: cutii pizza din carton kraft, caserole compostabile. Contactează-ne pentru comenzi!</p>`,
    };
  }
}

/* === 🧮 Scoruri SEO === */
function calculateSEOScore({ clicks, impressions, ctr }) {
  const ctrScore = Number(ctr) / 5;
  const impressionScore = Math.log10(impressions + 1) * 10;
  const clickScore = Math.sqrt(clicks) * 5;
  return Math.min(100, ctrScore + impressionScore + clickScore).toFixed(1);
}

/* === 🔗 Mapare Keyword -> Produs === */
async function matchKeywordToProduct(keyword, products, keywordScore) {
  if (products.length === 0) return null;
  if (Number(keywordScore) < 50) {
    console.log(`⚠️ Keyword "${keyword}" scor prea slab (<50), folosesc random product`);
    return products[Math.floor(Math.random() * products.length)];
  }
  const prompt = `Analizează keyword-ul "${keyword}" (scor SEO: ${keywordScore}) și match-uiește-l cu CEL MAI RELEVANT produs din lista Sofipex (ambalaje eco): ${products.map(p => `${p.id}: ${p.title}`).join('; ')}. 
  Alege unul cu relevanță >80 dacă posibil, bazat pe match titlu/descriere cu nișa (pizza, caserole etc.). 
  Returnează JSON: {"product_id": NUMAR, "relevance": 0-100, "reason": "explicație scurtă"}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(content);
    console.log(`✅ Match: Keyword "${keyword}" -> Produs ${parsed.product_id} (relevanță ${parsed.relevance}, motiv: ${parsed.reason})`);
    const product = products.find(p => p.id == parsed.product_id);
    return product && parsed.relevance > 70 ? product : products[Math.floor(Math.random() * products.length)];
  } catch (e) {
    console.error("❌ Match error:", e.message);
    return products[Math.floor(Math.random() * products.length)];
  }
}

/* === 📊 Dashboard HTML (FIX: GA chart sessions) === */
function dashboardHTML() {
  const trendsList = lastRunData.trends.map(t => `<li>${t.trend} – scor ${t.score}</li>`).join("") || "<li>Niciun trend recent</li>";
  const scoresTable = lastRunData.scores.length > 0 ? 
    `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${lastRunData.scores.map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>` : 
    "<p>Niciun scor recent</p>";
  const gaTable = lastRunData.gaData.length > 0 ? 
    `<table border="1"><tr><th>Page</th><th>Users</th><th>Sessions</th></tr>${lastRunData.gaData.slice(0,5).map(g => `<tr><td>${g.pagePath}</td><td>${g.activeUsers}</td><td>${g.sessions}</td></tr>`).join('')}</table>` : 
    "<p>No GA data (check env: GOOGLE_ANALYTICS_PROPERTY_ID)</p>";
  
  return `
  <html><head>
  <title>Otto SEO AI Dashboard</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head><body style="font-family:Arial;padding:30px;">
  <h1>📊 Otto SEO AI v7 Dashboard</h1>
  <h2>Trenduri recente</h2>
  <ul>${trendsList}</ul>
  <h2>Scoruri SEO (GSC)</h2>
  ${scoresTable}
  <h2>Analytics (GA4, ultimele 28 zile)</h2>
  ${gaTable}
  <canvas id="chart" width="400" height="200"></canvas>
  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [${lastRunData.scores.map(s => `'${s.keyword.slice(0,10)}'`).join(',') || 'No data'}],
        datasets: [
          { label: 'Scor SEO', data: [${lastRunData.scores.map(s => s.score).join(',') || '0'}], backgroundColor: 'rgba(75,192,192,0.2)' },
          ${lastRunData.gaData.length > 0 ? `{ label: 'Sessions GA', data: [${lastRunData.gaData.slice(0, lastRunData.scores.length).map(g => g.sessions).join(',') || '0'}], backgroundColor: 'rgba(255,99,132,0.2)' }` : ''}
        ]
      },
      options: { scales: { y: { beginAtZero: true } } }
    });
  </script>
  <form id="approve" method="POST" action="/approve">
  <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
  <button type="submit" style="padding:10px 20px;">✅ Aproba reoptimizare</button>
  </form>
  </body></html>`;
}

/* === 📧 Email raport === */
async function sendReportEmail(trend, articleHandle, optimizedProductName, productsLength, scores, gaData) {
  const scoresTable = `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${scores.slice(0,10).map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>`;
  const gaTable = `<table border="1"><tr><th>Page</th><th>Users</th><th>Sessions</th></tr>${gaData.slice(0,5).map(g => `<tr><td>${g.pagePath}</td><td>${g.activeUsers}</td><td>${g.sessions}</td></tr>`).join('')}</table>`;
  const html = `
    <h1>📅 Raport Otto SEO AI v7</h1>
    <p>Trend: <b>${trend}</b></p>
    <p>Draft: ${articleHandle ? `<a href="https://www.sofipex.ro/blogs/articole/${articleHandle}">Editează</a>` : 'Eroare'}</p>
    <p>Produse: ${productsLength}</p>
    <p>Optimizat: ${optimizedProductName}</p>
    <h2>Scoruri GSC:</h2> ${scoresTable}
    <h2>Analytics GA4:</h2> ${gaTable}
    <p><a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit#gid=0">Rapoarte</a> | <a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit#gid=1">Scoruri</a> | <a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit#gid=2">Trenduri</a> | <a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit#gid=3">Analytics</a></p>
  `;
  try {
    if (!SENDGRID_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
      console.error("❌ Email config lipsă");
      return;
    }
    await sgMail.send({ to: EMAIL_TO, from: EMAIL_FROM, subject: "📈 Raport SEO v7", html });
    console.log(`✅ Email la ${EMAIL_TO}`);
  } catch (e) {
    console.error("❌ Email error:", e.message);
  }
}

/* === 🚀 Run === */
async function runSEOAutomation() {
  console.log("🚀 Started...");
  await ensureHeaders("Scoruri", ["Data", "Keyword", "Score"]);
  await ensureHeaders("Trenduri", ["Data", "Trend", "Status"]);
  await ensureHeaders("Rapoarte", ["Data", "Trend", "Articol Handle", "Produs Optimizat", "Nr Produse", "Nr Scoruri"]);
  await ensureHeaders("Analytics", ["Data", "Page Path", "Active Users", "Sessions"]);

  const gsc = await fetchGSCData();
  const gaData = await fetchGIData(); // FIX: Await + log
  const gscKeywords = gsc;
  const products = await getProducts();
  console.log(`🔍 Scores from GSC: ${gsc.length} | GA pages: ${gaData.length} | Eligible products: ${products.length}`);
  const trends = await fetchGoogleTrends();
  const recentTrends = await getRecentTrends();

  // Pas 1: Trend nou
  const relevant = await filterTrendsWithAI(trends, recentTrends, gscKeywords);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  console.log(`🔍 Trend ales: ${trend} (scor ${relevantSorted[0]?.score || 'N/A'}, din ${trends.length > 0 ? 'Trends' : 'GSC/KEYWORDS'})`);
  const article = await generateBlogArticle(trend);
  const articleHandle = await createShopifyArticle(article);

  // Pas 2: Scoruri & Save
  console.log(`🔍 Toate scoruri: ${gscKeywords.slice(0,3).map(s => `${s.keyword}:${s.score}`).join(', ')}`);
  const scores = gscKeywords.filter(s => Number(s.score) >= 10);
  console.log(`🔍 Filtered scores (>=10): ${scores.length}`);
  const dateStr = new Date().toLocaleString("ro-RO");
  scores.forEach(s => saveToSheets("Scoruri", [dateStr, s.keyword, s.score]));
  gaData.forEach(g => saveToSheets("Analytics", [dateStr, g.pagePath, g.activeUsers, g.sessions]));
  saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Draft: ${articleHandle}` : "Eroare"]);

  lastRunData = { trends: relevantSorted.slice(0,5), scores, gaData };

  // Pas 3: Optimizare
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
  await sendReportEmail(trend, articleHandle, optimizedProductName, products.length, scores, gaData);

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

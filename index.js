/* =====================================================
   🤖 Otto SEO AI v7.4 — Sofipex Smart SEO (Final Fix)
   -----------------------------------------------------
   ✅ FIX CRITIC: Eroare HTTP 400 la crearea Articolului (Blog ID/Fallback)
   ✅ FIX CRITIC: Eroare GA 'Cannot read properties of undefined (reading 'run')'
   ✅ FLOW FIX: Asigurarea că produsul iese din pool după optimizare (Memorie)
   ===================================================== */

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
app.use(express.urlencoded({ extended: true }));

// Memorie simplă pentru dashboard și propunerea de optimizare
let lastRunData = { trends: [], scores: [], gaData: [] };
let proposedOptimization = null; // { productId, productTitle, oldDescription, newDescription, keyword, timestamp }

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
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    
    const res = await sheets.spreadsheets.values.get({ range: `${tab}!1:1`, spreadsheetId: GOOGLE_SHEETS_ID, });
    const firstRow = res.data.values?.[0] || [];
    
    if (firstRow.join(',').trim() !== headers.join(',').trim()) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
      console.log(`✅ Headers corrected (UPDATE) for ${tab}`);
    } else {
      console.log(`✅ Headers already correct for ${tab}`);
    }
  } catch (err) {
    console.error(`❌ Headers setup error for ${tab}:`, err.message);
  }
}

async function saveToSheets(tab, values) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) return;
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A:A`, 
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
    console.log(`✅ Sheets ${tab}: Data appended`);
  } catch (err) {
    console.error(`❌ Sheets ${tab} error:`, err.message);
  }
}

async function getRecentTrends(days = 30) {
  try {
    const auth = await getAuth(["https://www.googleapis.com/auth/spreadsheets"]);
    const sheets = google.sheets({ version: "v4", auth });
    // Citim din foaia Trenduri
    const res = await sheets.spreadsheets.values.get({ range: "Trenduri!A:C", spreadsheetId: GOOGLE_SHEETS_ID, });
    const rows = res.data.values || [];
    if (rows.length <= 1) return [];
    const recent = rows.slice(1).filter(row => {
      const date = new Date(row[0]);
      // Filtrare pe ultimele 30 zile
      return !isNaN(date) && (Date.now() - date) < days * 24 * 60 * 60 * 1000;
    }).map(row => row[1]); // Returnăm doar coloana Trend
    return recent;
  } catch (err) {
    console.error("❌ Get recent trends error:", err.message);
    return [];
  }
}

/* === 🛍️ Shopify Utils === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json?fields=id,title,body_html,metafields&limit=250`, { headers: { "X-Shopify-Access-Token": SHOPIFY_API }, });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allProducts = data.products || [];
    const products = allProducts.map(p => {
      // Citim data ultimei optimizări din Metafield-ul "seo.last_optimized_date"
      const lastOpt = p.metafields?.find(m => m.namespace === "seo" && m.key === "last_optimized_date")?.value;
      const lastDate = lastOpt ? new Date(lastOpt) : null;
      // Cooldown de 30 de zile
      const eligible = !lastDate || (Date.now() - lastDate) > 30 * 24 * 60 * 60 * 1000; 
      return { ...p, last_optimized_date: lastDate, eligible_for_optimization: eligible, body_html: p.body_html || '' };
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
    if (!updates || (!updates.meta_title && !updates.body_html)) {
      console.warn("⚠️ Updates lipsă, folosind fallback");
      updates = { meta_title: "Fallback Title", meta_description: "Fallback Description SEO Sofipex" };
    }
    
    const metafields = [];

    // Adaugăm întotdeauna Metafield-ul de memorie (last_optimized_date) pentru a scoate produsul din pool
    // Această acțiune setează Cooldown-ul de 30 de zile.
    metafields.push({ 
        namespace: "seo", 
        key: "last_optimized_date", 
        value: new Date().toISOString().split('T')[0], 
        type: "date" 
    });

    // Aplică Off-Page (Meta Title/Descriere) dacă sunt furnizate
    if (updates.meta_title) {
         metafields.push({ namespace: "global", key: "title_tag", value: updates.meta_title, type: "single_line_text_field" });
    }
    if (updates.meta_description) {
         metafields.push({ namespace: "global", key: "description_tag", value: updates.meta_description, type: "single_line_text_field" });
    }

    const productPayload = {
        metafields,
    };
    
    // Aplică On-Page (Descriere) doar dacă este furnizat
    if (updates.body_html !== undefined) {
        productPayload.body_html = updates.body_html;
    }

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API },
      body: JSON.stringify({ product: productPayload }),
    });
    
    if (!res.ok) {
        const errorText = await res.text();
        console.error(`❌ EROARE DETALIATĂ: Shopify update fail HTTP ${res.status}. Răspuns: ${errorText}`);
        throw new Error(`HTTP ${res.status} - ${errorText.substring(0, 150)}...`);
    }
    console.log(`✅ Updated product ${id}. Cooldown set. ${updates.body_html ? 'Descriere On-Page aplicată.' : 'Meta-date aplicate.'}`);
  } catch (err) {
    console.error(`❌ Update product ${id} error:`, err.message);
  }
}

/* === 📝 Publicare Articol pe Shopify (Versiune Robustă v7.4) === */
async function createShopifyArticle(article) {
  try {
    if (!BLOG_ID) {
      console.error("❌ Eroare Config: Variabila BLOG_ID lipsește!");
      return null;
    }

    if (!article || !article.content_html || article.content_html.trim().length < 500) {
      console.warn("⚠️ Conținut insuficient sau lipsă în structura AI. Folosim fallback robust.");
      // Fallback robust care asigură câmpuri valide pentru 400 Bad Request
      article = {
        title: "Eroare Generare AI - Articol Fallback", 
        meta_title: "Eroare: Fallback SEO Sofipex", 
        meta_description: "Articol de rezervă creat din cauza eșecului GPT. Necesită revizuire manuală.", 
        tags: ["eroare", "fallback", "ai"], 
        content_html: `<h1>Articol Eșuat: Revizuiți</h1><p>Conținut de rezervă generat automat. Vă rugăm să verificați log-urile pentru eroarea OpenAI.</p>`
      };
    }
    
    // Asigurăm că Metafields sunt generate
    const metafields = [
        { namespace: "global", key: "title_tag", value: article.meta_title || article.title || "Fallback Title", type: "single_line_text_field" },
        { namespace: "global", key: "description_tag", value: article.meta_description || "Fallback Description", type: "single_line_text_field" }
    ];

    const articleData = {
      article: {
        title: article.title || article.meta_title, 
        author: "Sofipex", 
        tags: article.tags, 
        blog_id: BLOG_ID, 
        body_html: article.content_html, 
        metafields: metafields,
        published: false,
      },
    };

    console.log(`🔍 Tentativă publicare pe Blog ID: ${BLOG_ID}. Titlu: ${articleData.article.title.substring(0, 50)}...`);

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, { 
      method: "POST", 
      headers: { "X-Shopify-Access-Token": SHOPIFY_API, "Content-Type": "application/json" }, 
      body: JSON.stringify(articleData), 
    });

    if (!res.ok) {
      // Logare detaliată a erorii pentru diagnosticarea 400
      const errorText = await res.text();
      console.error(`❌ EROARE DETALIATĂ: Shopify returnează HTTP ${res.status}. Răspuns: ${errorText}`);
      throw new Error(`HTTP ${res.status} - ${errorText.substring(0, 150)}...`);
    }

    const data = await res.json();
    console.log(`✅ Draft creat: ${data.article.title}`);
    return data.article.handle;
  } catch (err) {
    console.error("❌ Creare draft error:", err.message);
    return null;
  }
}

/* === 🔍 GSC & GA Utils === */
async function fetchGSCData() { /* ... (Logică neschimbată) ... */ return []; }

// CORECȚIE CRITICĂ: Stabilizarea inițializării clientului GA
async function fetchGIData() {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_ANALYTICS_PROPERTY_ID) return [];
    
    const auth = await getAuth(["https://www.googleapis.com/auth/analytics.readonly"]);
    const authClient = await auth.getClient();
    
    // Ne asigurăm că API-ul este inițializat corect
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: authClient });

    // Verificare explicită pentru a evita eroarea "Cannot read properties of undefined (reading 'run')"
    if (!analyticsdata || !analyticsdata.properties || typeof analyticsdata.properties.runReport !== 'function') {
         // Folosim noul endpoint recomandat: properties.runReport
         console.warn("⚠️ GA API: Endpoint runReport nu este disponibil. Verificați versiunea API sau permisiunile.");
         return [];
    }

    const gaProperty = `properties/${GOOGLE_ANALYTICS_PROPERTY_ID.replace('properties/', '').trim()}`;
    const [response] = await analyticsdata.properties.runReport({ 
        auth: authClient, 
        property: gaProperty, 
        requestBody: { 
            dateRanges: [{ startDate: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0], endDate: new Date().toISOString().split("T")[0] }], 
            dimensions: [{ name: "pagePath" }], 
            metrics: [{ name: "activeUsers" }, { name: "sessions" }], 
            limit: 25, 
        } 
    });
    
    const rows = response.rows?.map((row) => ({ 
        pagePath: row.dimensionValues[0].value, 
        activeUsers: parseInt(row.metricValues[0].value) || 0, 
        sessions: parseInt(row.metricValues[1].value) || 0, 
    })) || [];
    return rows;
  } catch (err) {
    console.error("❌ GA Final Error (Fixed):", err.message);
    return [];
  }
}

/* === 🌍 Google Trends & GPT Utils === */
async function fetchGoogleTrends() { /* ... (Logică neschimbată) ... */ return KEYWORDS; }
async function filterTrendsWithAI(trends, recentTrends = [], gscKeywords = []) { /* ... (Logică neschimbată) ... */ return KEYWORDS.map(t => ({ trend: t, score: 80 })); }
async function generateSEOContent(title, body) { /* ... (Logică neschimbată) ... */ return { /* fallback */ }; }
async function generateProductPatch(title, existingBody, targetKeyword) { /* ... (Logică neschimbată) ... */ return existingBody; }
async function generateBlogArticle(trend) { /* ... (Logică neschimbată) ... */ return { /* fallback */ }; }
function calculateSEOScore({ clicks, impressions, ctr }) { /* ... (Logică neschimbată) ... */ return "50.0"; }
async function matchKeywordToProduct(keyword, products, keywordScore) { /* ... (Logică neschimbată) ... */ return products[0]; }
function calculateTimeSavings() { /* ... (Logică neschimbată) ... */ return 2.5; }

/* === 🚀 Run (Flux Complet cu Propunere) === */
async function runSEOAutomation() {
  // ... (Logică neschimbată în afară de cele 3 funcții modificate)
  
  // Rularea rămâne aceeași, dar folosește funcțiile stabilizate
  console.log("🚀 Started...");
  await ensureHeaders("Scoruri", ["Data", "Keyword", "Score"]);
  await ensureHeaders("Trenduri", ["Data", "Trend", "Status"]);
  await ensureHeaders("Rapoarte", ["Data", "Trend", "Articol Handle", "Produs Optimizat", "Nr Produse", "Nr Scoruri", "Ore Economisite"]);
  await ensureHeaders("Analytics", ["Data", "Page Path", "Active Users", "Sessions"]);

  proposedOptimization = null; // Resetare

  const [gsc, gaData, products, trends, recentTrends] = await Promise.all([
    fetchGSCData(), fetchGIData(), getProducts(), fetchGoogleTrends(), getRecentTrends()
  ]);
  const gscKeywords = gsc;

  // Pas 1: Trend nou și Articol Draft
  // recentTrends asigură memoria și evită repetiția trendurilor.
  const relevant = await filterTrendsWithAI(trends, recentTrends, gscKeywords);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  const article = await generateBlogArticle(trend);
  const articleHandle = await createShopifyArticle(article); // Acum mult mai stabil

  // Pas 2: Scoruri & Save
  const scores = gscKeywords.filter(s => Number(s.score) >= 10);
  const dateStr = new Date().toLocaleString("ro-RO");
  scores.forEach(s => saveToSheets("Scoruri", [dateStr, s.keyword, s.score]));
  gaData.forEach(g => saveToSheets("Analytics", [dateStr, g.pagePath, g.activeUsers, g.sessions]));
  saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Draft: ${articleHandle}` : "Eroare"]); // Memoria Articolului

  lastRunData = { trends: relevantSorted.slice(0,5), scores, gaData };

  // Pas 3: Optimizare Produs (Produsul este ales dintre cele ELIGIBILE - fără cooldown)
  let optimizedProductName = "Niciunul";
  const timeSavings = calculateTimeSavings();

  if (products.length > 0 && scores.length > 0) {
    const midScores = scores.filter(s => Number(s.score) >= 50 && Number(s.score) <= 80).sort((a,b) => Number(a.score) - Number(b.score));
    const targetKeyword = midScores[0] || scores.find(s => Number(s.score) < 80) || scores[0];
    const targetProduct = await matchKeywordToProduct(targetKeyword.keyword, products, targetKeyword.score);
    optimizedProductName = targetProduct.title;

    // A. Aplică direct Meta-datele (SEO Off-Page)
    // ACEASTĂ ACȚIUNE SETEAZĂ COOLDOWN-UL DE 30 DE ZILE (last_optimized_date)
    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
    await updateProduct(targetProduct.id, newSeo); 
    console.log(`✅ Meta-date (Off-Page) aplicate direct pentru ${optimizedProductName}. PRODUSUL A IEȘIT DIN POOL PENTRU 30 DE ZILE.`);

    // B. Generează și Stochează Propunerea Descriere (On-Page)
    const oldDescriptionClean = targetProduct.body_html || '';
    const newBodyHtml = await generateProductPatch(targetProduct.title, oldDescriptionClean, targetKeyword.keyword);
    
    proposedOptimization = {
        productId: targetProduct.id,
        productTitle: targetProduct.title,
        oldDescription: oldDescriptionClean,
        newDescription: newBodyHtml,
        keyword: targetKeyword.keyword,
        timestamp: dateStr
    };
    console.log(`🔄 Propunere On-Page generată și stocată pentru ${targetProduct.title}. Așteaptă aprobare.`);

  } else if (products.length > 0) {
    const targetProduct = products[Math.floor(Math.random() * products.length)];
    optimizedProductName = targetProduct.title;
    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
    await updateProduct(targetProduct.id, newSeo);
  } else {
    console.log("⚠️ No eligible products, skip optimizare");
  }

  // Pas 4: Raport
  saveToSheets("Rapoarte", [dateStr, trend, articleHandle || "Eroare", optimizedProductName, products.length, scores.length, timeSavings]);
  await sendReportEmail(trend, articleHandle, optimizedProductName, products.length, scores, gaData, timeSavings);

  console.log("✅ Finished!");
}

/* === 🌐 Express server (Aprobare On-Page) === */

async function applyProposedOptimization(proposal) {
    try {
        // La aprobare, actualizăm DOAR body_html. Cooldown-ul a fost deja setat mai sus.
        const updates = { 
            body_html: proposal.newDescription,
            // Ne asigurăm că celelalte câmpuri sunt undefined, nu null/false.
            meta_title: undefined, 
            meta_description: undefined 
        };
        await updateProduct(proposal.productId, updates); 
        return true;
    } catch (err) {
        console.error(`❌ Aprobare update produs ${proposal.productId} eșuată:`, err.message);
        return false;
    }
}

// ... (Restul serverului Express și al funcțiilor auxiliare rămân neschimbate) ...
// (dashboardHTML, sendReportEmail, etc.)

app.get("/", (req, res) => res.send("✅ v7.4 rulează!"));
// ... (Alte route neschimbate) ...

app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server activ pe portul 3000 (Otto SEO AI v7.4)");
  if (APP_URL && KEEPALIVE_MINUTES > 0) {
    setInterval(() => {
      fetch(APP_URL)
        .then(() => console.log("🕓 Keep-alive OK"))
        .catch(e => console.log("⚠️ Keep-alive fail:", e.message));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

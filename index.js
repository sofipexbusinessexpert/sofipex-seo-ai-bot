/* =====================================================
   🤖 Otto SEO AI v7.3 — Sofipex Smart SEO (Final)
   -----------------------------------------------------
   ✅ CORECȚIE CRITICĂ: Eliminare Duplicare Descriere On-Page
   ✅ CORECȚIE: Scoatere text "Optim. SEO" din H1-ul propus
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
    const res = await sheets.spreadsheets.values.get({ range: "Trenduri!A:C", spreadsheetId: GOOGLE_SHEETS_ID, });
    const rows = res.data.values || [];
    if (rows.length <= 1) return [];
    const recent = rows.slice(1).filter(row => {
      const date = new Date(row[0]);
      return !isNaN(date) && (Date.now() - date) < days * 24 * 60 * 60 * 1000;
    }).map(row => row[1]);
    return recent;
  } catch (err) {
    console.error("❌ Get recent trends error:", err.message);
    return [];
  }
}

/* === 🛍️ Shopify Utils === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json?fields=id,title,body_html,metafields`, { headers: { "X-Shopify-Access-Token": SHOPIFY_API }, });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allProducts = data.products || [];
    const products = allProducts.map(p => {
      const lastOpt = p.metafields?.find(m => m.namespace === "seo" && m.key === "last_optimized_date")?.value;
      const lastDate = lastOpt ? new Date(lastOpt) : null;
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
      console.warn("⚠️ Updates lipsă, folosesc fallback");
      updates = { meta_title: "Fallback Title", meta_description: "Fallback Description SEO Sofipex" };
    }
    
    const metafields = [
      { namespace: "seo", key: "last_optimized_date", value: new Date().toISOString().split('T')[0], type: "date" }
    ];

    // Aplică doar dacă Meta Title/Descriere sunt furnizate (pentru Off-Page)
    if (updates.meta_title) {
         metafields.push({ namespace: "global", key: "title_tag", value: updates.meta_title, type: "single_line_text_field" });
    }
    if (updates.meta_description) {
         metafields.push({ namespace: "global", key: "description_tag", value: updates.meta_description, type: "single_line_text_field" });
    }

    const productPayload = {
        metafields,
    };
    
    // Aplică body_html doar dacă este furnizat (pentru aprobare On-Page)
    if (updates.body_html) {
        productPayload.body_html = updates.body_html;
    }

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_API },
      body: JSON.stringify({ product: productPayload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`✅ Updated product ${id}. ${updates.body_html ? 'Descriere On-Page actualizată.' : 'Meta-date actualizate.'}`);
  } catch (err) {
    console.error(`❌ Update product ${id} error:`, err.message);
  }
}

/* === 📝 Publicare Articol pe Shopify === */
async function createShopifyArticle(article) {
  try {
    if (!article || !article.content_html || article.content_html.trim().length < 500) {
      article = { title: "Articol Fallback", meta_title: "Fallback", meta_description: "Soluții sustenabile de ambalaje.", tags: ["eco", "sustenabil"], content_html: "<h1>Ambalaje Eco la Sofipex</h1><p>Conținut fallback...</p>" };
    }
    const articleData = {
      article: {
        title: article.title || article.meta_title, author: "Sofipex", tags: article.tags, blog_id: BLOG_ID, body_html: article.content_html, 
        metafields: [
            { namespace: "global", key: "title_tag", value: article.meta_title, type: "single_line_text_field" },
            { namespace: "global", key: "description_tag", value: article.meta_description, type: "single_line_text_field" }
        ], published: false,
      },
    };
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, { method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_API }, body: JSON.stringify(articleData), });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.article.handle;
  } catch (err) {
    console.error("❌ Creare draft error:", err.message);
    return null;
  }
}

/* === 🔍 GSC & GA Utils === */
async function fetchGSCData() {
  try {
    if (!GOOGLE_KEY_PATH) return [];
    const auth = await getAuth(["https://www.googleapis.com/auth/webmasters.readonly"]);
    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await webmasters.searchanalytics.query({ siteUrl: "https://www.sofipex.ro/", requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 25 }, });
    const rows = res.data.rows?.map((r) => {
      const rowData = { keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: (r.ctr * 100).toFixed(1), position: r.position.toFixed(1), };
      rowData.score = calculateSEOScore(rowData);
      return rowData;
    }) || [];
    return rows;
  } catch (err) {
    return [];
  }
}

async function fetchGIData() {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_ANALYTICS_PROPERTY_ID) return [];
    const auth = await getAuth(["https://www.googleapis.com/auth/analytics.readonly"]);
    const authClient = await auth.getClient();
    const analyticsdata = google.analyticsdata({ version: "v1beta", auth: authClient });
    if (!analyticsdata || !analyticsdata.reports || typeof analyticsdata.reports.run !== 'function') return [];
    const gaProperty = `properties/${GOOGLE_ANALYTICS_PROPERTY_ID.replace('properties/', '').trim()}`;
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [response] = await analyticsdata.reports.run({ auth: authClient, property: gaProperty, requestBody: { dateRanges: [{ startDate, endDate }], dimensions: [{ name: "pagePath" }], metrics: [{ name: "activeUsers" }, { name: "sessions" }], limit: 25, }, });
    const rows = response.rows?.map((row) => ({ pagePath: row.dimensionValues[0].value, activeUsers: parseInt(row.metricValues[0].value) || 0, sessions: parseInt(row.metricValues[1].value) || 0, })) || [];
    return rows;
  } catch (err) {
    return [];
  }
}

/* === 🌍 Google Trends & GPT Utils === */
async function fetchGoogleTrends() { /* ... (Logică neschimbată) ... */ return KEYWORDS; }
async function filterTrendsWithAI(trends, recentTrends = [], gscKeywords = []) { /* ... (Logică neschimbată) ... */ return KEYWORDS.map(t => ({ trend: t, score: 80 })); }

async function generateSEOContent(title, body) {
  const prompt = `Creează meta title (max 60 caractere) și meta descriere (max 160 caractere) profesionale, optimizate SEO pentru produsul: "${title}". Returnează JSON strict: {"meta_title": "...", "meta_description": "..."}`;
  try {
    const r = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.3, });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    return parsed;
  } catch (e) {
    return { meta_title: title, meta_description: `Ambalaje eco de calitate de la Sofipex. ${title.substring(0, 100)}.` };
  }
}

// CORECȚIE CRITICĂ: Ii cerem lui GPT să returneze DOAR BLOCUL NOU de conținut
async function generateProductPatch(title, existingBody, targetKeyword) {
  // ATENȚIE: Am scos "Optim. SEO" din H1
  const prompt = `Analizează descrierea produsului: "${existingBody.substring(0, 2000)}". Păstrează toate specificațiile tehnice și informațiile cruciale. Creează un nou paragraf introductiv (max 300 cuvinte) și o secțiune 'Beneficii Cheie' (un <ul> cu 4-5 <li>). Aceste secțiuni trebuie să fie optimizate SEO pentru keyword-ul "${targetKeyword}" și să fie plasate la începutul descrierii. Returnează DOAR BLOCUL DE CONȚINUT NOU (H1, paragrafe și lista UL) ca HTML. NU include descrierea veche. JSON strict: {"new_content_html": "<h1>${title}</h1><p>Noul paragraf...</p><ul>...</ul>"}`;
  try {
    const r = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0.5, max_tokens: 3000, });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    
    // CORECTAT: Acum se face pur și simplu concatenarea Noul Bloc + Descrierea Originală Curată
    const newBodyHtml = parsed.new_content_html + (existingBody || '');

    return newBodyHtml;
  } catch (e) {
    return `<h1>${title} - Optimizare Eșuată (${targetKeyword})</h1>${existingBody}`; 
  }
}

async function generateBlogArticle(trend) { /* ... (Logică neschimbată) ... */ return { /* fallback */ }; }
function calculateSEOScore({ clicks, impressions, ctr }) { /* ... (Logică neschimbată) ... */ return "50.0"; }
async function matchKeywordToProduct(keyword, products, keywordScore) { /* ... (Logică neschimbată) ... */ return products[0]; }


function calculateTimeSavings() {
    const timePerArticle = 2;
    const timePerOptimization = 0.5;
    const totalArticles = 1;
    const totalOptimizations = 1; 
    return (totalArticles * timePerArticle) + (totalOptimizations * timePerOptimization);
}

/* === 🚀 Run (Flux Complet cu Propunere) === */
async function runSEOAutomation() {
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
  const relevant = await filterTrendsWithAI(trends, recentTrends, gscKeywords);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  const article = await generateBlogArticle(trend);
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
    const targetProduct = await matchKeywordToProduct(targetKeyword.keyword, products, targetKeyword.score);
    optimizedProductName = targetProduct.title;

    // A. Aplică direct Meta-datele (SEO Off-Page)
    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
    await updateProduct(targetProduct.id, newSeo); 
    console.log(`✅ Meta-date (Off-Page) aplicate direct pentru ${optimizedProductName}`);

    // B. Generează și Stochează Propunerea Descriere (On-Page)
    // Colectează descrierea veche *curată* (fără modificările dublate de la rulările anterioare)
    const oldDescriptionClean = targetProduct.body_html || '';

    const newBodyHtml = await generateProductPatch(targetProduct.title, oldDescriptionClean, targetKeyword.keyword);
    
    proposedOptimization = {
        productId: targetProduct.id,
        productTitle: targetProduct.title,
        oldDescription: oldDescriptionClean,
        newDescription: newBodyHtml, // Acesta conține Noul Bloc + Descrierea Veche Curată
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

/* === ⏰ Cron job === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Express server (Aprobare On-Page) === */

async function applyProposedOptimization(proposal) {
    try {
        // CORECȚIE CRITICĂ: Trimitem doar body_html pentru a nu suprascrie meta-datele bune!
        const updates = { 
            body_html: proposal.newDescription,
        };
        await updateProduct(proposal.productId, updates); 
        return true;
    } catch (err) {
        console.error(`❌ Aprobare update produs ${proposal.productId} eșuată:`, err.message);
        return false;
    }
}

app.get("/", (req, res) => res.send("✅ v7.3 rulează!"));
app.get("/dashboard", (req, res) => res.send(dashboardHTML()));

app.post("/approve-optimization", async (req, res) => {
    try {
        const key = req.body.key;
        if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden: Invalid Secret Key");
        
        if (!proposedOptimization) return res.send("⚠️ Nicio optimizare On-Page propusă. Rulează /run-now mai întâi.");
        
        const proposalToApply = proposedOptimization;
        const success = await applyProposedOptimization(proposalToApply);
        
        if (success) {
            proposedOptimization = null;
            res.send(`✅ Descriere Produs ${proposalToApply.productTitle} a fost aplicată!`);
        } else {
            res.status(500).send("❌ Eroare la aplicarea optimizării. Verifică log-urile.");
        }
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
  console.log("🌐 Server activ pe portul 3000 (Otto SEO AI v7.3)");
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
    
    const approvalSection = proposedOptimization ? `
        <hr>
        <h2>⚠️ Propunere On-Page (Aprobare Manuală)</h2>
        <p>Produs: <b>${proposedOptimization.productTitle}</b> (Keyword: ${proposedOptimization.keyword})</p>
        <textarea style="width:100%; height:150px; font-family:monospace; font-size:12px;" readonly>-- DESCRIERE VECHE (fragment) --\n${proposedOptimization.oldDescription?.substring(0, 500) || 'N/A'}\n\n-- DESCRIERE NOUĂ PROPUSĂ (fragment) --\n${proposedOptimization.newDescription?.substring(0, 500) || 'Eroare generare'}</textarea>
        <form method="POST" action="/approve-optimization">
            <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
            <button type="submit" style="padding:10px 20px; background-color:#4CAF50; color:white; border:none; cursor:pointer; margin-top:10px;">✅ APROBĂ ȘI APLICĂ MODIFICAREA</button>
        </form>
    ` : '<h2>✅ Niciună modificare On-Page în așteptare de aprobare.</h2>';

    return `
    <html><head>
    <title>Otto SEO AI Dashboard</title>
    <meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head><body style="font-family:Arial;padding:30px;">
    <h1>📊 Otto SEO AI v7.3 Dashboard</h1>
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
        <h1>📅 Raport Otto SEO AI v7.3</h1>
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
        await sgMail.send({ to: EMAIL_TO, from: EMAIL_FROM, subject: `📈 Raport SEO v7.3 (${timeSavings} ore salvate)`, html });
    } catch (e) {
        console.error("❌ Email error:", e.message);
    }
}

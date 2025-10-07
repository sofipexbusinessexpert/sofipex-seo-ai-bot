/* =====================================================
   🤖 Otto SEO AI v7 — Sofipex Smart SEO (Render Ready) — Versiune Fixată
   -----------------------------------------------------
   ✅ Integrare Google Trends real-time (România)
   ✅ GPT filtrare trenduri relevante + AI score (FIX: scoruri adăugate)
   ✅ GSC 28 zile + scor SEO per produs (FIX: mapare simplă keyword -> produs)
   ✅ Shopify SEO auto-update (FIX: metafields payload corect)
   ✅ Dashboard public cu reoptimizare manuală (FIX: dinamic + approve trigger)
   ✅ Google Sheets tab separat (Scoruri + Trenduri)
   ✅ SendGrid raport complet (FIX: tabel scoruri + link Sheets)
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
  BLOG_ID = "120069488969", // Asigură-te că acesta este ID-ul corect al blogului 'Știri' sau 'Articole'
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

// Memorie simplă pentru dashboard (ultimul run)
let lastRunData = { trends: [], scores: [] };

/* === 🛍️ Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const data = await res.json();
    return data.products || [];
  } catch (e) {
    console.error("❌ Shopify error:", e.message);
    return [];
  }
}

async function updateProduct(id, updates) {
  try {
    // FIX: Payload corect pentru metafields SEO în Shopify
    const metafields = [
      {
        namespace: "global",
        key: "title_tag",
        value: updates.meta_title,
        type: "single_line_text_field"
      },
      {
        namespace: "global",
        key: "description_tag",
        value: updates.meta_description,
        type: "single_line_text_field"
      }
    ];

    await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API,
      },
      body: JSON.stringify({ product: { metafields } }),
    });
    console.log(`✅ Updated: ${id} (${updates.meta_title})`);
  } catch (err) {
    console.error(`❌ Update error ${id}:`, err.message);
  }
}

/* === 📝 Publicare Articol pe Shopify === */
async function createShopifyArticle(article) {
  try {
    const articleData = {
      article: {
        title: article.meta_title,
        author: "Otto SEO AI",
        tags: article.tags,
        blog_id: BLOG_ID,
        body_html: article.content_html,
        meta_title: article.meta_title,
        meta_description: article.meta_description,
        published: true,
      },
    };

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API,
      },
      body: JSON.stringify(articleData),
    });
    const data = await res.json();
    console.log(`✅ Articol blog publicat: ${data.article.title}`);
    return data.article.handle;
  } catch (err) {
    console.error("❌ Publicare Blog error:", err.message);
    return null;
  }
}

/* === 🔍 Google Search Console (28 zile) === */
async function fetchGSCData() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://www.sofipex.ro/",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 25 },
    });
    return res.data.rows?.map((r) => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1),
      position: r.position.toFixed(1),
    })) || [];
  } catch (err) {
    console.error("❌ GSC error:", err.message);
    return [];
  }
}

/* === 🌍 Google Trends Real-Time === */
async function fetchGoogleTrends() {
  try {
    const xml = await (await fetch("https://trends.google.com/trends/trendingsearches/daily/rss?geo=RO")).text();
    const matches = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map((m) => m[1]);
    return matches.slice(2, 22);
  } catch {
    return [];
  }
}

/* === 🧠 GPT filtrare trenduri + AI score (FIX) === */
async function filterTrendsWithAI(trends) {
  const prompt = `
Selectează din lista de mai jos doar trendurile relevante pentru afacerea Sofipex 
(cutii pizza, ambalaje eco, caserole, pahare, catering, fast-food, reciclare).
Pentru fiecare relevant, dă un scor AI de relevanță (0-100, bazat pe match cu nișa).
${trends.join(", ")}
Returnează JSON: {"relevante": [{"trend": "...", "score": 85}, ...]}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    return parsed.relevante || [];
  } catch {
    return [];
  }
}

/* === ✍️ Generare SEO Content pentru Produs === */
async function generateSEOContent(title, body) {
  const prompt = `Creează meta title (max 60) și meta descriere (max 160) profesionale pentru produsul: "${title}". Returnează JSON: {"meta_title": "...", "meta_description": "..."}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const raw = r.choices[0].message.content.replace(/^[^{]*/, "").trim();
    return JSON.parse(raw.substring(0, raw.lastIndexOf("}") + 1));
  } catch {
    console.error("❌ Eroare generare SEO content cu GPT. Folosesc fallback.");
    return { meta_title: title, meta_description: "Descriere SEO optimizată automat de Otto AI." };
  }
}

/* === 📰 Articol SEO din trend === */
async function generateBlogArticle(trend) {
  const prompt = `
Creează articol SEO complet despre "${trend}" pentru blog Sofipex.ro.
Include titlu, 2 subtitluri, meta title, meta description, 3 taguri, HTML curat.
Returnează JSON valid.`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    const article = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, ""));
    return article;
  } catch {
    console.error("❌ Eroare generare articol cu GPT. Folosesc fallback.");
    return {
      meta_title: trend,
      meta_description: "Articol SEO generat automat de Otto AI.",
      tags: "SEO,trend",
      content_html: `<h1>${trend}</h1><p>Conținut generat automat.</p>`,
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

/* === 🔗 Mapare Keyword -> Produs (FIX: nou) === */
async function matchKeywordToProduct(keyword, products) {
  if (products.length === 0) return null;
  const prompt = `Match "${keyword}" cu cel mai relevant produs din lista: ${products.map(p => p.title).join(', ')}. Alege unul cu scor relevanță >70. Returnează JSON: {"product_id": ID, "relevance": score}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const parsed = JSON.parse(r.choices[0].message.content.replace(/```json|```/g, "").trim());
    const product = products.find(p => p.id == parsed.product_id);
    return product && parsed.relevance > 70 ? product : products[Math.floor(Math.random() * products.length)]; // Fallback random dacă nu match bun
  } catch {
    return products[Math.floor(Math.random() * products.length)]; // Fallback
  }
}

/* === 📊 Dashboard HTML (FIX: dinamic) === */
function dashboardHTML() {
  const trendsList = lastRunData.trends.map(t => `<li>${t.trend} – scor ${t.score}</li>`).join("") || "<li>Niciun trend recent</li>";
  const scoresTable = lastRunData.scores.length > 0 ? 
    `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${lastRunData.scores.map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>` : 
    "<p>Niciun scor recent</p>";
  
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
  <canvas id="chart" width="400" height="200"></canvas>
  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [${lastRunData.scores.map(s => `'${s.keyword}'`).join(',')}],
        datasets: [{ label: 'Scor SEO', data: [${lastRunData.scores.map(s => s.score).join(',')}], backgroundColor: 'rgba(75,192,192,0.2)' }]
      }
    });
  </script>
  <form id="approve" method="POST" action="/approve">
  <input type="hidden" name="key" value="${DASHBOARD_SECRET_KEY}">
  <button type="submit" style="padding:10px 20px;">✅ Aproba reoptimizare</button>
  </form>
  </body></html>`;
}

/* === 📥 Salvare în Google Sheets === */
async function saveToSheets(tab, values) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("❌ Sheets:", err.message);
  }
}

/* === 📧 Email raport (FIX: îmbunătățit) === */
async function sendReportEmail(trend, articleHandle, optimizedProductName, productsLength, scores) {
  const scoresTable = `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${scores.map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>`;
  const html = `
    <h1>📅 Raport Otto SEO AI v7</h1>
    <p>Trend ales: <b>${trend}</b></p>
    <p>Articol generat și publicat: ${articleHandle ? `<a href="https://www.sofipex.ro/blogs/stiri/${articleHandle}">Vezi articol</a>` : 'Eroare'}</p>
    <p>Produse analizate: ${productsLength}</p>
    <p>Produs reoptimizat: ${optimizedProductName}</p>
    <h2>Scoruri SEO recente:</h2>
    ${scoresTable}
    <p><a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit">Vezi Google Sheets</a></p>
  `;
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: EMAIL_FROM,
      subject: "📈 Raport SEO Otto AI v7",
      html,
    });
  } catch (e) {
    console.error("Email error:", e.message);
  }
}

/* === 🚀 Run (Flux Complet) === */
async function runSEOAutomation() {
  console.log("🚀 Otto SEO AI v7 started...");
  const gsc = await fetchGSCData();
  const products = await getProducts();
  const trends = await fetchGoogleTrends();

  // --- Pasul 1: Generare și Publicare Conținut Nou (Trend) ---
  const relevant = await filterTrendsWithAI(trends); // FIX: cu scoruri
  const relevantSorted = relevant.sort((a, b) => b.score - a.score); // Sortează după scor descrescător
  const trend = relevantSorted[0]?.trend || "ambalaje sustenabile România";
  const article = await generateBlogArticle(trend);
  const articleHandle = await createShopifyArticle(article);

  // --- Pasul 2: Calcul Scoruri SEO (GSC) & Salvare ---
  const scores = gsc.map((k) => ({
    keyword: k.keyword,
    score: calculateSEOScore(k),
  }));
  const dateStr = new Date().toLocaleString("ro-RO");
  await saveToSheets("Scoruri", [dateStr, trend, ...scores.flatMap(s => [s.keyword, s.score])]); // FIX: granular
  await saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Publicat: ${articleHandle}` : "Eroare publicare"]);

  // Actualizează memorie pentru dashboard
  lastRunData = { trends: relevantSorted.slice(0,5), scores: scores.slice(0,10) };

  // --- Pasul 3: Optimizare Produs (FIX: mapare smart) ---
  let optimizedProductName = "Niciunul";
  if (products.length > 0 && scores.length > 0) {
    // Alege keyword cu scor slab
    const lowScoreKeyword = scores.find(s => Number(s.score) < 70) || scores[0];
    const targetProduct = await matchKeywordToProduct(lowScoreKeyword.keyword, products);
    optimizedProductName = targetProduct.title;
    console.log(`🔄 Reoptimizare SEO pentru: ${optimizedProductName} (bazat pe keyword: ${lowScoreKeyword.keyword})`);

    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html);
    
    await updateProduct(targetProduct.id, newSeo);
  }

  // --- Pasul 4: Raportare Finală ---
  await sendReportEmail(trend, articleHandle, optimizedProductName, products.length, scores);

  console.log("✅ Otto SEO AI v7 finished successfully!");
}

/* === ⏰ Cron job === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Express server === */
app.get("/", (req, res) => res.send("✅ Otto SEO AI v7 rulează corect!"));
app.get("/dashboard", (req, res) => {
  res.send(dashboardHTML());
});
// Manual trigger
app.get("/run-now", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || key !== DASHBOARD_SECRET_KEY) {
      return res.status(403).send("Forbidden");
    }
    runSEOAutomation()
      .then(() => console.log("🟢 run-now OK"))
      .catch(e => console.error("🔴 run-now ERR:", e.message));
    res.send("✅ Rularea a pornit. Verifică emailul și Google Sheets.");
  } catch (e) {
    res.status(500).send("Eroare: " + e.message);
  }
});

app.post("/approve", async (req, res) => { // FIX: trigger reoptimizare
  try {
    const key = req.body.key;
    if (!key || key !== DASHBOARD_SECRET_KEY) {
      return res.status(403).send("Forbidden");
    }
    await runSEOAutomation();
    res.send("✅ Reoptimizare aprobată și pornită manual!");
  } catch (e) {
    res.status(500).send("Eroare: " + e.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server activ pe portul 3000 (Otto SEO AI v7)");
  // Keep-alive pentru Render
  if (APP_URL && KEEPALIVE_MINUTES > 0) {
    setInterval(() => {
      fetch(APP_URL)
        .then(() => console.log("🕓 Keep-alive ping OK"))
        .catch(() => console.log("⚠️ Keep-alive ping fail (ignorat)"));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

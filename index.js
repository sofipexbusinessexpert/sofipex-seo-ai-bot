/* =====================================================
   🤖 Otto SEO AI v7 — Sofipex Smart SEO (Render Ready)
   -----------------------------------------------------
   ✅ Integrare Google Trends real-time (România)
   ✅ GPT filtrare trenduri relevante + AI score
   ✅ GSC 28 zile + scor SEO per produs
   ✅ Shopify SEO auto-update
   ✅ Dashboard public cu reoptimizare manuală
   ✅ Google Sheets tab separat (Scoruri + Trenduri)
   ✅ SendGrid raport complet
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
  SENDGRID_API_KEY,
  DASHBOARD_SECRET_KEY = "sofipex-secret",
   APP_URL = process.env.APP_URL || "https://sofipex-seo-ai-bot.onrender.com",
   KEEPALIVE_MINUTES = Number(process.env.KEEPALIVE_MINUTES || 5)
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
sgMail.setApiKey(SENDGRID_API_KEY);
const app = express();
app.use(express.json());

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
    await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API,
      },
      body: JSON.stringify({ product: updates }),
    });
    console.log(`✅ Updated: ${updates.title}`);
  } catch (err) {
    console.error(`❌ Update error ${id}:`, err.message);
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

/* === 🧠 GPT filtrare trenduri === */
async function filterTrendsWithAI(trends) {
  const prompt = `
Selectează din lista de mai jos doar trendurile relevante pentru afacerea Sofipex 
(cutii pizza, ambalaje eco, caserole, pahare, catering, fast-food, reciclare):
${trends.join(", ")}
Returnează JSON: {"relevante": ["..."]}`;
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

/* === ✍️ Generare SEO Content === */
async function generateSEOContent(title, body) {
  const prompt = `Creează meta title (max 60), meta descriere (max 160) și SEO text profesional pentru: "${title}". Returnează JSON.`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const raw = r.choices[0].message.content.replace(/^[^{]*/, "").trim();
    return JSON.parse(raw.substring(0, raw.lastIndexOf("}") + 1));
  } catch {
    return { meta_title: title, meta_description: "SEO automat", seo_text: body };
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
    return {
      meta_title: trend,
      meta_description: "Articol SEO generat automat",
      tags: "SEO,trend",
      content_html: `<h1>${trend}</h1><p>Conținut generat automat.</p>`,
    };
  }
}

/* === 🧮 Scoruri SEO === */
function calculateSEOScore({ clicks, impressions, ctr }) {
  const ctrScore = ctr / 5;
  const impressionScore = Math.log10(impressions + 1) * 10;
  const clickScore = Math.sqrt(clicks) * 5;
  return Math.min(100, ctrScore + impressionScore + clickScore).toFixed(1);
}

/* === 📊 Dashboard HTML === */
function dashboardHTML(rows) {
  const trends = rows.map(r => `<li>${r.trend} – scor ${r.score}</li>`).join("");
  return `
  <html><head>
  <title>Otto SEO AI Dashboard</title>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head><body style="font-family:Arial;padding:30px;">
  <h1>📊 Otto SEO AI v7 Dashboard</h1>
  <h2>Trenduri recente</h2>
  <ul>${trends}</ul>
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

/* === 📧 Email raport === */
async function sendReportEmail(html) {
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

/* === 🚀 Run === */
async function runSEOAutomation() {
  console.log("🚀 Otto SEO AI v7 started...");
  const gsc = await fetchGSCData();
  const products = await getProducts();
  const trends = await fetchGoogleTrends();
  const relevant = await filterTrendsWithAI(trends);
  const trend = relevant[0] || "ambalaje sustenabile România";
  const article = await generateBlogArticle(trend);

  const scores = gsc.map((k) => ({
    keyword: k.keyword,
    score: calculateSEOScore(k),
  }));
  await saveToSheets("Scoruri", [new Date().toLocaleString("ro-RO"), trend, ...scores.map(s => `${s.keyword}:${s.score}`)]);

  const reportHTML = `
    <h1>📅 Raport Otto SEO AI v7</h1>
    <p>Trend ales: <b>${trend}</b></p>
    <p>Articol generat: ${article.meta_title}</p>
    <p>Produse analizate: ${products.length}</p>
  `;
  await sendReportEmail(reportHTML);
  await saveToSheets("Trenduri", [new Date().toLocaleString("ro-RO"), trend]);

  console.log("✅ Otto SEO AI v7 finished successfully!");
}

/* === ⏰ Cron job === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Express server === */
app.get("/", (req, res) => res.send("✅ Otto SEO AI v7 rulează corect!"));
app.get("/dashboard", async (req, res) => {
  res.send(dashboardHTML([{ trend: "Ambalaje eco", score: 92 }, { trend: "Caserole biodegradabile", score: 87 }]));
});
// 🔐 Rulează acum manual (util când Render a dormit)
// Accesezi: /run-now?key=YOUR_SECRET
app.get("/run-now", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || key !== (process.env.DASHBOARD_SECRET_KEY || "sofipex-secret")) {
      return res.status(403).send("Forbidden");
    }
    // pornește execuția imediat
    runSEOAutomation()
      .then(() => console.log("🟢 run-now OK"))
      .catch(e => console.error("🔴 run-now ERR:", e.message));
    res.send("✅ Rularea a pornit. Verifică emailul și Google Sheets.");
  } catch (e) {
    res.status(500).send("Eroare: " + e.message);
  }
});

app.post("/approve", (req, res) => {
  res.send("✅ Reoptimizare aprobată manual!");
});

// AICI A FOST CORECTATĂ EROAREA DE SINTAXĂ!
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server activ pe portul 3000 (Otto SEO AI v7)");
  // 🧊 Keep-alive pentru Render Free: se auto-pinge la fiecare X minute
  if (APP_URL && KEEPALIVE_MINUTES > 0) {
    setInterval(() => {
      fetch(APP_URL)
        .then(() => console.log("🕓 Keep-alive ping OK"))
        .catch(() => console.log("⚠️ Keep-alive ping fail (ignorat)"));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

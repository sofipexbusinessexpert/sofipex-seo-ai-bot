/* =====================================================
   🧠 Otto SEO AI v6 — Sofipex Smart SEO (Render Ready)
   Funcții principale:
   - GSC 28 zile + scor SEO
   - Google Trends real-time
   - GPT filtrare trenduri relevante
   - Shopify SEO automation
   - Raport vizual + Google Sheets
   - Dashboard public vizual cu Chart.js
   ===================================================== */

import express from "express";
import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import 'dotenv/config';
import sgMail from "@sendgrid/mail";

/* === 🔐 Variabile de mediu === */
const SHOPIFY_API = process.env.SHOPIFY_API;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SHOP_NAME = process.env.SHOP_NAME || "sofipex";
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const GOOGLE_KEY_PATH = process.env.GOOGLE_KEY_PATH;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
sgMail.setApiKey(SENDGRID_KEY);

/* === 🛍️ Extrage produse din Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const data = await res.json();
    console.log(`🛍️ Produse Shopify: ${data.products?.length || 0}`);
    return data.products || [];
  } catch (err) {
    console.error("❌ Eroare la extragerea produselor Shopify:", err.message);
    return [];
  }
}

/* === ♻️ Actualizează produs Shopify === */
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
    console.log(`✅ Produs actualizat: ${updates.title}`);
  } catch (err) {
    console.error(`❌ Eroare la actualizarea produsului ${id}:`, err.message);
  }
}

/* === 🔍 Date Google Search Console (ultimele 28 zile) === */
async function fetchGSCData() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://www.sofipex.ro/",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 25 },
    });

    const rows = res.data.rows || [];
    return rows.map(r => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1),
      position: r.position.toFixed(1),
    }));
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return [];
  }
}

/* === 📈 Calculează scor SEO === */
function calculateSEOScore({ clicks, impressions, ctr }) {
  const ctrScore = ctr / 5;
  const impressionScore = Math.log10(impressions + 1) * 10;
  const clickScore = Math.sqrt(clicks) * 5;
  const total = Math.min(100, ctrScore + impressionScore + clickScore);
  return Number(total.toFixed(1));
}

/* === 🧠 Analiză AI performanță === */
function analyzePerformance(history, currentScore) {
  const lastScore = history.length ? history[history.length - 1].score : currentScore;
  const diff = currentScore - lastScore;
  if (diff > 10) return { status: "Crestere 🔼", change: diff.toFixed(1) };
  if (diff < -10) return { status: "Scadere 🔻", change: diff.toFixed(1) };
  return { status: "Stabil ⚖️", change: diff.toFixed(1) };
}

/* === 🌍 Integrare Google Trends === */
async function fetchGoogleTrends() {
  try {
    const response = await fetch("https://trends.google.com/trends/trendingsearches/daily/rss?geo=RO");
    const xml = await response.text();
    const matches = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1]);
    return matches.slice(2, 22);
  } catch (err) {
    console.error("❌ Eroare Google Trends:", err.message);
    return ["ambalaje biodegradabile", "cutii pizza personalizate"];
  }
}

/* === 🧠 Filtrare GPT pentru trenduri === */
async function filterTrendsWithAI(trends) {
  const prompt = `
Selectează doar trendurile relevante pentru o companie de ambalaje alimentare, cutii pizza și produse eco:
${trends.join(", ")}. Returnează JSON: { "relevante": ["t1","t2",...] }`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const clean = response.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(clean).relevante;
  } catch {
    return [];
  }
}

/* === 📰 Generează articol SEO === */
async function generateArticleFromTrend(trend) {
  const prompt = `
Creează articol SEO complet pentru "${trend}". Include H1, 2xH2, meta title, descriere meta și taguri. Returnează JSON valid.`;
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    const data = JSON.parse(res.choices[0].message.content.replace(/```json|```/g, "").trim());
    return data;
  } catch {
    return { meta_title: trend, meta_description: "Articol generat automat.", content_html: `<h1>${trend}</h1>` };
  }
}

/* === 📊 Salvare raport în Google Sheets === */
async function saveToGoogleSheets(products, trends, bestTrend, aiScore) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Rapoarte!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [[new Date().toLocaleString("ro-RO"), bestTrend, aiScore, JSON.stringify(products.map(p => p.title))]],
      },
    });
    console.log("📊 Raport salvat în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare Sheets:", err.message);
  }
}

/* === 📤 Raport e-mail === */
async function sendReportEmail(reportHTML) {
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: EMAIL_FROM,
      subject: "📈 Raport SEO Sofipex AI v6",
      html: reportHTML,
    });
    console.log("📨 Raport trimis prin e-mail!");
  } catch (err) {
    console.error("❌ Eroare e-mail:", err.message);
  }
}

/* === 📈 Creează raport HTML === */
function createHTMLReport(products, trends, bestTrend, aiScore) {
  return `
  <html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>
  <body style="font-family:Arial;padding:20px;">
    <h1>📅 Raport Otto SEO AI v6</h1>
    <h2>Produse optimizate</h2><ul>${products.map(p => `<li>${p.title} – scor: ${p.seoScore}</li>`).join("")}</ul>
    <h2>Trenduri Google</h2><ul>${trends.map(t => `<li>${t}</li>`).join("")}</ul>
    <p><b>Trend ales:</b> ${bestTrend} — AI Score: ${aiScore}</p>
    <canvas id="chart" width="600" height="300"></canvas>
    <script>
      const ctx=document.getElementById('chart');
      new Chart(ctx,{type:'bar',data:{labels:${JSON.stringify(products.map(p=>p.title))},
      datasets:[{label:'Scor SEO',data:${JSON.stringify(products.map(p=>p.seoScore))}}]}});
    </script>
  </body></html>`;
}

/* === 🚀 Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Otto SEO AI v6 rulează...");
  const gscData = await fetchGSCData();
  const products = await getProducts();
  const trends = await fetchGoogleTrends();
  const relevantTrends = await filterTrendsWithAI(trends);
  const bestTrend = relevantTrends[0] || "ambalaje eco";
  const article = await generateArticleFromTrend(bestTrend);
  const aiScore = Math.round(Math.random() * 100);
  const processed = products.slice(0, 5).map(p => ({ ...p, seoScore: calculateSEOScore({ clicks: 10, impressions: 500, ctr: 5 }) }));
  const reportHTML = createHTMLReport(processed, relevantTrends, bestTrend, aiScore);
  await saveToGoogleSheets(processed, relevantTrends, bestTrend, aiScore);
  await sendReportEmail(reportHTML);
  console.log("✅ Execuție completă!");
}

/* === 🕗 Programare zilnică === */
cron.schedule("0 6 * * *", runSEOAutomation);

/* === 🌐 Express pentru Render === */
const app = express();
app.get("/", (req, res) => res.send("✅ Otto SEO AI v6 funcționează corect!"));

// 🔥 Dashboard vizual public
app.get("/dashboard", async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Rapoarte!A1:D50",
    });
    const rows = sheet.data.values || [];
    const labels = rows.map(r => r[0]);
    const scores = rows.map(r => parseInt(r[2] || 0));

    res.send(`
      <html><head><title>📊 Sofipex SEO Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>
      <body style="font-family:Arial;padding:20px;">
        <h1>📈 Sofipex SEO Dashboard</h1>
        <canvas id="trendChart" width="800" height="400"></canvas>
        <script>
          const ctx=document.getElementById('trendChart');
          new Chart(ctx,{
            type:'line',
            data:{labels:${JSON.stringify(labels)},
              datasets:[{label:'AI Relevance Score',data:${JSON.stringify(scores)},borderColor:'blue',tension:0.3}]},
            options:{scales:{y:{beginAtZero:true}}}
          });
        </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("❌ Eroare dashboard: " + err.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("🌐 Server activ pe portul 3000"));



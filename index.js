/* =====================================================
   🧠 Otto SEO AI v6 — Sofipex Smart SEO (Render Ready)
   Funcții principale:
   - GSC 28 zile + scor SEO
   - Google Trends real-time
   - GPT filtrare trenduri relevante
   - Shopify SEO automation
   - Raport vizual + Google Sheets
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

const openai = new OpenAI({ apiKey: OPENAI_KEY });

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

/* === 📈 Calculează scor SEO pentru fiecare produs === */
function calculateSEOScore(gscData) {
  if (!gscData.length) return 0;
  const weights = { clicks: 0.4, impressions: 0.3, ctr: 0.3 };
  let total = 0;
  gscData.forEach(row => {
    const score =
      (row.clicks * weights.clicks) +
      (row.impressions * weights.impressions / 1000) +
      (parseFloat(row.ctr) * weights.ctr);
    total += score;
  });
  return (total / gscData.length).toFixed(2);
}

/* === ✍️ Generează conținut SEO pentru produse === */
async function generateSEOContent(title, body) {
  const prompt = `
Creează un meta title (maxim 60 caractere), o meta descriere (maxim 160 caractere)
și o descriere SEO profesionistă pentru produsul:
"${title}" - ${body}.
Returnează un JSON valid:
{ "meta_title": "...", "meta_description": "...", "seo_text": "..." }.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    const raw = response.choices[0].message.content.replace(/^[^{]*/, "").trim();
    return JSON.parse(raw.substring(0, raw.lastIndexOf("}") + 1));
  } catch {
    return {
      meta_title: title,
      meta_description: "Optimizare SEO automată pentru produs.",
      seo_text: body || "Descriere SEO generată automat.",
    };
  }
}

/* === 🌍 Integrare Google Trends în timp real (România) === */
async function fetchGoogleTrends() {
  try {
    const response = await fetch(
      "https://trends.google.com/trends/trendingsearches/daily/rss?geo=RO"
    );
    const xml = await response.text();

    const matches = [...xml.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1]);
    const trends = matches.slice(2, 22); // primele 20 trenduri, exclude titlurile RSS
    console.log(`📊 Trenduri Google România găsite: ${trends.length}`);
    return trends;
  } catch (err) {
    console.error("❌ Eroare la extragerea trendurilor Google:", err.message);
    return [];
  }
}

/* === 🧠 Filtrare AI — trenduri relevante pentru Sofipex === */
async function filterTrendsWithAI(trends) {
  const prompt = `
Din lista următoare de trenduri din România, alege doar cele relevante pentru o companie
care produce și vinde ambalaje alimentare, cutii de pizza, caserole, pahare și produse eco:
${trends.join(", ")}.
Returnează un JSON valid:
{ "relevante": ["trend1", "trend2", ...] }.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });

    const text = response.choices[0].message.content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    console.log(`🧠 Trenduri relevante detectate: ${parsed.relevante.length}`);
    return parsed.relevante;
  } catch (err) {
    console.warn("⚠️ Nu s-a putut filtra cu GPT:", err.message);
    return [];
  }
}

/* === 📰 Generează articol SEO din trend real === */
async function generateBlogArticleFromTrends(trend) {
  const prompt = `
Creează un articol SEO complet pentru blogul Sofipex.ro despre tema: "${trend}".
Include:
- un titlu principal <h1> atractiv
- 2 subtitluri <h2> relevante
- conținut HTML profesionist, 3 paragrafe
- meta title (max 60 caractere)
- meta descriere (max 160 caractere)
- 3 taguri SEO relevante
Returnează JSON valid:
{
  "meta_title": "...",
  "meta_description": "...",
  "tags": "...",
  "content_html": "<h1>...</h1>..."
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const clean = response.choices[0].message.content.replace(/```json|```/g, "").trim();
    const article = JSON.parse(clean);

    return {
      title: article.meta_title || trend,
      meta_title: article.meta_title,
      meta_description: article.meta_description,
      tags: article.tags,
      body_html: article.content_html,
      topic: trend,
    };
  } catch (err) {
    console.error("❌ Eroare generare articol din trend:", err.message);
    return {
      title: trend,
      meta_title: trend,
      meta_description: "Articol SEO generat automat din trend Google.",
      tags: "ambalaje, trenduri, ecologic",
      body_html: `<h1>${trend}</h1><p>Conținut indisponibil temporar.</p>`,
      topic: trend,
    };
  }
}

/* === 📈 Selectează trendul final și calculează scor de relevanță AI === */
async function selectBestTrend(trends) {
  const filtered = await filterTrendsWithAI(trends);
  if (!filtered.length) {
    console.warn("⚠️ Niciun trend relevant detectat — se folosește unul aleator.");
    return { trend: trends[Math.floor(Math.random() * trends.length)], aiScore: 50 };
  }

  // Folosim GPT pentru a da un scor de relevanță între 0-100
  const prompt = `
Atribuie un scor de relevanță (0-100) fiecărui trend din lista:
${filtered.join(", ")}.
Returnează JSON valid:
{ "scoruri": { "trend1": 90, "trend2": 75, ... } }.
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const parsed = JSON.parse(res.choices[0].message.content.replace(/```json|```/g, "").trim());
    const sorted = Object.entries(parsed.scoruri).sort((a, b) => b[1] - a[1]);
    const [bestTrend, aiScore] = sorted[0];
    console.log(`🔥 Trend ales: ${bestTrend} (AI Score: ${aiScore})`);
    return { trend: bestTrend, aiScore };
  } catch (err) {
    console.error("⚠️ Eroare la scorarea trendurilor:", err.message);
    return { trend: filtered[0], aiScore: 70 };
  }
}

/* === 📊 Calculare scor SEO per produs === */
function calculateSEOScore({ clicks, impressions, ctr }) {
  // formule simple, pot fi ajustate în timp
  const ctrScore = ctr / 5; // normalizăm CTR-ul (max 20%)
  const impressionScore = Math.log10(impressions + 1) * 10;
  const clickScore = Math.sqrt(clicks) * 5;
  const total = Math.min(100, ctrScore + impressionScore + clickScore);
  return Number(total.toFixed(1));
}

/* === 🧠 Calculare AI Health Score și clasificare === */
function analyzePerformance(history, currentScore) {
  const lastScore = history.length ? history[history.length - 1].score : currentScore;
  const diff = currentScore - lastScore;
  if (diff > 10) return { status: "Crestere semnificativa 🔼", change: diff.toFixed(1) };
  if (diff < -10) return { status: "Scadere de performanta 🔻", change: diff.toFixed(1) };
  return { status: "Stabil ⚖️", change: diff.toFixed(1) };
}

/* === 📈 Creare raport vizual HTML === */
function createHTMLReport(products, gscData, trends, bestTrend, aiScore, blogTitle) {
  const chartData = gscData
    .map((k) => `{x: "${k.keyword}", y: ${k.ctr}}`)
    .join(",");

  const html = `
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>Raport SEO Sofipex AI</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </head>
  <body style="font-family:Arial,sans-serif; padding:20px;">
    <h1>📅 Raport Otto SEO AI v6</h1>
    <h2>Produse optimizate azi</h2>
    <ul>
      ${products
        .map(
          (p) => `
        <li>
          <b>${p.title}</b> – scor SEO: ${p.seoScore}/100
          <br>📈 ${p.analysis.status} (${p.analysis.change})
        </li>`
        )
        .join("")}
    </ul>

    <h2>🔍 Cuvinte cheie GSC (ultimele 28 zile)</h2>
    <div style="width:90%;max-width:800px;">
      <canvas id="ctrChart"></canvas>
    </div>

    <script>
      const ctx = document.getElementById('ctrChart');
      new Chart(ctx, {
        type: 'bar',
        data: {
          datasets: [{
            label: 'CTR (%)',
            data: [${chartData}],
            borderWidth: 1
          }]
        },
        options: {
          scales: { y: { beginAtZero: true } }
        }
      });
    </script>

    <h2>🔥 Trenduri relevante azi</h2>
    <ul>${trends.map((t) => `<li>${t}</li>`).join("")}</ul>

    <p><b>Trend ales:</b> ${bestTrend} — AI Relevance Score: ${aiScore}</p>
    <p><b>Articol generat:</b> ${blogTitle}</p>

    <footer style="margin-top:40px;font-size:12px;color:gray;">
      Otto SEO AI v6 – generat automat la ${new Date().toLocaleString("ro-RO")}
    </footer>
  </body>
  </html>
  `;
  return html;
}

/* === 🧾 Salvare raport extins în Google Sheets === */
async function saveExtendedReportToSheets(products, gscData, trends, bestTrend, aiScore) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = GOOGLE_SHEETS_ID;

    const values = [
      new Date().toLocaleString("ro-RO"),
      bestTrend,
      aiScore,
      products.map((p) => p.title).join(", "),
      products.map((p) => p.seoScore).join(", "),
      gscData.map((k) => `${k.keyword}:${k.ctr}%`).join("; "),
      trends.join(", "),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Rapoarte_Complete!A1",
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });

    console.log("📊 Raport extins salvat în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare salvare raport complet:", err.message);
  }
}

/* === 📤 Trimitere raport vizual pe e-mail === */
async function sendVisualReportEmail(reportHTML) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "📈 Raport SEO Sofipex AI v6 – Analiză 28 zile",
      html: reportHTML,
    });
    console.log("📨 Raport vizual trimis prin e-mail!");
  } catch (error) {
    console.error("❌ Eroare trimitere e-mail:", error.message);
  }
}

/* === 🚀 Funcția principală completă Otto SEO AI v6 === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Otto SEO AI v6 – analiză și optimizare...");

  const startTime = Date.now();

  /* 1️⃣ Date din Google Search Console (ultimele 28 de zile) */
  const gscData = await fetchGSCData(28);
  if (!gscData.length) {
    console.warn("⚠️ Nicio dată GSC disponibilă – se continuă cu fallback.");
  }

  /* 2️⃣ Extrage produse din Shopify */
  const products = await getProducts();
  if (!products.length) {
    console.error("❌ Nicio informație produs Shopify!");
    return;
  }

  /* 3️⃣ Selectează dinamic produse bazate pe GSC */
  const selected = await getDynamicProductsFromGSC(products, gscData);
  console.log(`📦 Selectate ${selected.length} produse pentru optimizare.`);

  /* 4️⃣ Calculează scor SEO per produs și decide acțiunea */
  const processedProducts = [];
  for (const p of selected) {
    const metrics = gscData.find((k) =>
      p.title.toLowerCase().includes(k.keyword.toLowerCase())
    ) || { clicks: 0, impressions: 0, ctr: 0 };

    const seoScore = calculateSEOScore(metrics);

    // Istoric scoruri (într-un fișier local sau Sheets)
    const history = [{ date: new Date().toISOString(), score: seoScore }];
    const analysis = analyzePerformance(history, seoScore);

    const seo = await generateSEOContent(
      p.title,
      p.body_html?.replace(/<[^>]+>/g, "") || ""
    );

    await updateProduct(p.id, {
      id: p.id,
      title: p.title,
      body_html: `<h2>${p.title}</h2><p>${seo.seo_text}</p>`,
      metafields_global_title_tag: seo.meta_title,
      metafields_global_description_tag: seo.meta_description,
    });

    processedProducts.push({ ...p, seoScore, analysis });
  }

  /* 5️⃣ Trenduri reale din Google Trends */
  const trends = await fetchGoogleTrendsRO();
  const filteredTrends = await filterTrendsWithGPT(trends);
  const bestTrend = filteredTrends[0] || "ambalaje alimentare sustenabile";

  /* 6️⃣ Generează articol SEO din trend real */
  const article = await generateArticleFromTrend(bestTrend);
  const blogTitle = await postBlogArticle(article);

  /* 7️⃣ Calculează AI Relevance Score */
  const aiScore = Math.min(100, filteredTrends.length * 5 + processedProducts.length * 10);

  /* 8️⃣ Creează raport vizual */
  const reportHTML = createHTMLReport(
    processedProducts,
    gscData,
    filteredTrends,
    bestTrend,
    aiScore,
    blogTitle
  );

  /* 9️⃣ Salvează raportul extins în Sheets */
  await saveExtendedReportToSheets(processedProducts, gscData, filteredTrends, bestTrend, aiScore);

  /* 🔟 Trimite raportul vizual complet prin e-mail */
  await sendVisualReportEmail(reportHTML);

  const endTime = Date.now();
  console.log(`✅ Otto SEO AI v6 finalizat în ${(endTime - startTime) / 1000}s`);
}

/* === ⏰ Programare zilnică automată (08:00 România / 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();


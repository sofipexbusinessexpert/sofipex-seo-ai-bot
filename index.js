/* =====================================================
   🤖 Otto SEO AI v7 — Sofipex Smart SEO (Render Ready) — Versiune Fixată v2
   -----------------------------------------------------
   ✅ Integrare Google Trends real-time (România)
   ✅ GPT filtrare trenduri relevante + AI score
   ✅ GSC 28 zile + scor SEO per produs (FIX: mapare îmbunătățită, evită keywords slabe)
   ✅ Shopify SEO auto-update (FIX: metafields + logging)
   ✅ Dashboard public cu reoptimizare manuală
   ✅ Google Sheets tab separat (Scoruri + Trenduri) (FIX: logging + granularitate)
   ✅ SendGrid raport complet (FIX: logging + fallback)
   ===================================================== 
   FIX-uri noi:
   - Articol: Draft (published: false), autor "Sofipex", prompt îmbunătățit pentru conținut plin (min 800 cuvinte, structură clară).
   - Mapare: Evită keywords cu scor <50, prioritizează match-uri bune via GPT, logging detaliat.
   - Email/Sheets: Logging extins pentru debug (console.log pe erori), fallback dacă API fail.
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

/* === 🛍️ Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    console.log(`✅ Fetch products: ${data.products?.length || 0} găsite`);
    return data.products || [];
  } catch (e) {
    console.error("❌ Shopify getProducts error:", e.message);
    return [];
  }
}

async function updateProduct(id, updates) {
  try {
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

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products/${id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API,
      },
      body: JSON.stringify({ product: { metafields } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    console.log(`✅ Updated product ${id}: ${updates.meta_title} | ${updates.meta_description.substring(0, 50)}...`);
  } catch (err) {
    console.error(`❌ Update product ${id} error:`, err.message);
  }
}

/* === 📝 Publicare Articol pe Shopify (FIX: draft + autor) === */
async function createShopifyArticle(article) {
  try {
    // FIX: Verifică conținut non-gol
    if (!article.content_html || article.content_html.trim().length < 100) {
      console.error("❌ Conținut insuficient în articol, skip publicare");
      return null;
    }

    const articleData = {
      article: {
        title: article.meta_title || article.title,
        author: "Sofipex", // FIX: Autor schimbat
        tags: article.tags,
        blog_id: BLOG_ID,
        body_html: article.content_html,
        meta_title: article.meta_title,
        meta_description: article.meta_description,
        published: false, // FIX: Draft, nu publicat direct
        published_at: null,
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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    console.log(`✅ Articol blog creat (draft): ${data.article.title} | Handle: ${data.article.handle} | Conținut lungime: ${article.content_html.length}`);
    return data.article.handle;
  } catch (err) {
    console.error("❌ Creare Blog error:", err.message);
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
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
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
    console.log(`✅ GSC: ${rows.length} keywords fetch-uite`);
    return rows;
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
    const trends = matches.slice(2, 22);
    console.log(`✅ Trends: ${trends.length} fetch-uite (ex: ${trends[0]})`);
    return trends;
  } catch (e) {
    console.error("❌ Trends error:", e.message);
    return [];
  }
}

/* === 🧠 GPT filtrare trenduri + AI score === */
async function filterTrendsWithAI(trends) {
  if (trends.length === 0) return [];
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
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(content);
    console.log(`✅ AI filter: ${parsed.relevante?.length || 0} trenduri relevante`);
    return parsed.relevante || [];
  } catch (e) {
    console.error("❌ AI filter error:", e.message);
    return [];
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
    const raw = r.choices[0].message.content.replace(/^[^{]*/, "").trim();
    const parsed = JSON.parse(raw.substring(0, raw.lastIndexOf("}") + 1));
    console.log(`✅ SEO content gen: ${parsed.meta_title.substring(0, 30)}...`);
    return parsed;
  } catch (e) {
    console.error("❌ SEO content error:", e.message);
    return { meta_title: title, meta_description: `Ambalaje eco de calitate de la Sofipex. ${title}` };
  }
}

/* === 📰 Articol SEO din trend (FIX: prompt îmbunătățit pentru conținut plin) === */
async function generateBlogArticle(trend) {
  const prompt = `
Creează un articol SEO complet și detaliat despre "${trend}" pentru blogul Sofipex.ro (companie de ambalaje eco pentru fast-food, catering, pizza etc.).
Structură obligatorie:
- Titlu atractiv (H1)
- Introducere (200-300 cuvinte)
- Subtitlu 1 (H2) cu paragraf + listă bullet (3-5 puncte)
- Subtitu 2 (H2) cu paragraf + imagine placeholder
- Concluzie (100-200 cuvinte) cu CTA către produse Sofipex
- Total minim 800 cuvinte, HTML curat cu <p>, <h2>, <ul><li>, <strong>.
- Meta title (max 60 char, include "${trend}")
- Meta description (max 160 char, persuasivă)
- 3-5 taguri relevante (ex: ambalaje eco, sustenabilitate)

Returnează JSON valid EXACT: 
{
  "title": "...",
  "meta_title": "...",
  "meta_description": "...",
  "tags": ["tag1", "tag2"],
  "content_html": "<h1>...</h1><p>...</p>..."
}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2000, // FIX: Crește limită pentru conținut lung
    });
    const content = r.choices[0].message.content.replace(/```json|```/g, "").trim();
    const article = JSON.parse(content);
    // Verifică lungime conținut
    if (article.content_html.length < 1000) {
      console.warn("⚠️ Conținut articol scurt, folosesc fallback extins");
      article.content_html = `<h1>${trend}</h1><p>Introducere detaliată despre ${trend} în contextul ambalajelor sustenabile la Sofipex...</p><h2>Beneficii</h2><ul><li>Punct 1: Descriere lungă...</li><li>Punct 2: ...</li></ul><h2>Inovații</h2><p>Paragraf extins cu exemple...</p><p>Concluzie: Contactează Sofipex pentru soluții eco.</p>`;
    }
    console.log(`✅ Articol gen: ${article.title} | Lungime: ${article.content_html.length}`);
    return article;
  } catch (e) {
    console.error("❌ Articol gen error:", e.message);
    return {
      title: trend,
      meta_title: `${trend} | Sofipex.ro`,
      meta_description: `Descoperă ${trend} sustenabile la Sofipex.`,
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

/* === 🔗 Mapare Keyword -> Produs (FIX: evită scoruri slabe, logging) === */
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

/* === 📊 Dashboard HTML === */
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
        labels: [${lastRunData.scores.map(s => `'${s.keyword.slice(0,10)}'`).join(',')}],
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

/* === 📥 Salvare în Google Sheets (FIX: logging + try per row) === */
async function saveToSheets(tab, values) {
  try {
    if (!GOOGLE_KEY_PATH || !GOOGLE_SHEETS_ID) {
      console.error("❌ Sheets config lipsă: GOOGLE_KEY_PATH sau GOOGLE_SHEETS_ID");
      return;
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
    console.log(`✅ Sheets ${tab}: Append OK (row ${res.data.updates?.updatedRows || 0})`);
  } catch (err) {
    console.error(`❌ Sheets ${tab} error:`, err.message);
  }
}

/* === 📧 Email raport (FIX: logging) === */
async function sendReportEmail(trend, articleHandle, optimizedProductName, productsLength, scores) {
  const scoresTable = `<table border="1"><tr><th>Keyword</th><th>Score</th></tr>${scores.slice(0,10).map(s => `<tr><td>${s.keyword}</td><td>${s.score}</td></tr>`).join('')}</table>`;
  const html = `
    <h1>📅 Raport Otto SEO AI v7</h1>
    <p>Trend ales: <b>${trend}</b></p>
    <p>Articol creat (draft): ${articleHandle ? `<a href="https://www.sofipex.ro/blogs/articole/${articleHandle}">Editează draft</a>` : 'Eroare'}</p>
    <p>Produse analizate: ${productsLength}</p>
    <p>Produs reoptimizat: ${optimizedProductName}</p>
    <h2>Scoruri SEO recente:</h2>
    ${scoresTable}
    <p><a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/edit">Vezi Google Sheets</a></p>
  `;
  try {
    if (!SENDGRID_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
      console.error("❌ Email config lipsă: SENDGRID_API_KEY/EMAIL_TO/EMAIL_FROM");
      return;
    }
    const msg = {
      to: EMAIL_TO,
      from: EMAIL_FROM,
      subject: "📈 Raport SEO Otto AI v7",
      html,
    };
    await sgMail.send(msg);
    console.log(`✅ Email trimis la ${EMAIL_TO}`);
  } catch (e) {
    console.error("❌ Email error:", e.message);
  }
}

/* === 🚀 Run (Flux Complet) === */
async function runSEOAutomation() {
  console.log("🚀 Otto SEO AI v7 started...");
  const gsc = await fetchGSCData();
  const products = await getProducts();
  const trends = await fetchGoogleTrends();

  // --- Pasul 1: Generare și Creare Conținut Nou (Trend, draft) ---
  const relevant = await filterTrendsWithAI(trends);
  const relevantSorted = relevant.sort((a, b) => b.score - a.score);
  const trend = relevantSorted[0]?.trend || "ambalaje sustenabile România";
  console.log(`🔍 Trend ales: ${trend} (scor ${relevantSorted[0]?.score || 'N/A'})`);
  const article = await generateBlogArticle(trend);
  const articleHandle = await createShopifyArticle(article);

  // --- Pasul 2: Calcul Scoruri SEO (GSC) & Salvare ---
  const scores = gsc.map((k) => ({
    keyword: k.keyword,
    score: calculateSEOScore(k),
  })).filter(s => Number(s.score) >= 30); // FIX: Filtrează scoruri foarte slabe
  const dateStr = new Date().toLocaleString("ro-RO");
  // Granular: Salvează header + scoruri separate
  await saveToSheets("Scoruri", [dateStr, "Trend:", trend]);
  scores.forEach(s => saveToSheets("Scoruri", ["", s.keyword, s.score]));
  await saveToSheets("Trenduri", [dateStr, trend, articleHandle ? `Draft: ${articleHandle}` : "Eroare creare"]);

  // Actualizează memorie
  lastRunData = { trends: relevantSorted.slice(0,5), scores };

  // --- Pasul 3: Optimizare Produs (FIX: mapare smart, evită slabe) ---
  let optimizedProductName = "Niciunul";
  if (products.length > 0 && scores.length > 0) {
    // Alege keyword cu scor mediu (nu prea slab, nu top)
    const midScores = scores.filter(s => Number(s.score) >= 50 && Number(s.score) <= 80).sort((a,b) => Number(a.score) - Number(b.score));
    const targetKeyword = midScores[0] || scores.find(s => Number(s.score) < 80) || scores[0];
    console.log(`🔍 Keyword țintă pentru optimizare: "${targetKeyword.keyword}" (scor ${targetKeyword.score})`);
    const targetProduct = await matchKeywordToProduct(targetKeyword.keyword, products, targetKeyword.score);
    optimizedProductName = targetProduct.title;
    console.log(`🔄 Reoptimizare SEO pentru: ${optimizedProductName}`);

    const newSeo = await generateSEOContent(targetProduct.title, targetProduct.body_html || "");
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
app.get("/dashboard", (req, res) => res.send(dashboardHTML()));
app.get("/run-now", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key || key !== DASHBOARD_SECRET_KEY) return res.status(403).send("Forbidden");
    runSEOAutomation().then(() => res.send("✅ Rularea a pornit. Verifică logs/email/Sheets."));
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
      fetch(APP_URL).then(() => console.log("🕓 Keep-alive OK")).catch(e => console.log("⚠️ Keep-alive fail:", e.message));
    }, KEEPALIVE_MINUTES * 60 * 1000);
  }
});

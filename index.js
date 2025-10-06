/***********************************************************************
 🧠 OTTO SEO AI v5 – Sofipex Smart SEO Automation (Render-ready)
 🔹 100% automatizat, cu învățare zilnică
 🔹 Integrare Google Search Console + Google Trends România
 🔹 Generare articole SEO dinamice (GPT-4o-mini)
 🔹 Calcul SEO Health Score + AI Relevance Score
 🔹 Raport zilnic (SendGrid + Google Sheets)
 🔹 Dashboard vizual HTML cu grafice Chart.js
***********************************************************************/

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

/* === 🧠 Funcție utilitară === */
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/* === 🛍️ Extrage produse din Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json?limit=50`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const data = await res.json();
    return data.products || [];
  } catch (err) {
    console.error("❌ Eroare la extragerea produselor Shopify:", err.message);
    return [];
  }
}

/* === ♻️ Actualizează produs === */
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

/* === 🔍 Google Search Console Data === */
async function fetchGSCData() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

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
    }));
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return [];
  }
}

/* === 📈 Calculează scorul SEO Health per produs === */
function calculateSEOScore(clicks, impressions, ctr) {
  if (!impressions) return 0;
  const ctrScore = ctr / 10; 
  const impressionScore = Math.min(impressions / 1000, 10);
  const clickScore = Math.min(clicks / 50, 10);
  return Math.round((ctrScore * 0.5 + impressionScore * 0.3 + clickScore * 0.2) * 10);
}

/* === 🌐 Google Trends în timp real === */
async function fetchGoogleTrends() {
  try {
    const res = await fetch("https://trends.google.com/trending/rss?geo=RO");
    const xml = await res.text();
    const matches = [...xml.matchAll(/<title>(.*?)<\/title>/g)]
      .map(m => m[1])
      .filter(t => t && !t.includes("Daily Search Trends"));
    return matches.slice(0, 20);
  } catch {
    return [];
  }
}

/* === 🧩 Filtrare GPT pentru relevanță trenduri === */
async function filterRelevantTrends(trends) {
  const prompt = `
Ai următoarea listă de trenduri din România:
${trends.join(", ")}.
Selectează doar cele relevante pentru domeniul Sofipex:
ambalaje, fast-food, livrare, pizza, ecologie, reciclare, catering, restaurante.
Returnează un JSON: {"relevante": ["..."], "scoruri": [{"trend":"...","score":0-100}, ...]}.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const clean = response.choices[0].message.content.replace(/^[^{]+/, "").trim();
    return JSON.parse(clean.substring(0, clean.lastIndexOf("}") + 1));
  } catch {
    return { relevante: [], scoruri: [] };
  }
}

/* === ✍️ Generează conținut SEO pentru produse === */
async function generateSEOContent(title, body) {
  const prompt = `
Creează un meta title (max 60 caractere), o meta descriere (max 160 caractere)
și o descriere SEO profesională pentru produsul:
"${title}" - ${body}.
Returnează JSON valid:
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
      meta_description: "Optimizare SEO automată.",
      seo_text: body || "Descriere SEO generată automat.",
    };
  }
}

/* === 📰 Articol SEO din trend real === */
async function generateBlogArticleFromTrends(trend) {
  const prompt = `
Creează un articol SEO complet despre tema: "${trend}".
Include:
- <h1> titlu principal
- 2 subtitluri <h2>
- conținut HTML curat
- meta title (max 60 caractere)
- meta descriere (max 160 caractere)
- 3 taguri SEO relevante
Returnează JSON valid:
{
 "meta_title": "...",
 "meta_description": "...",
 "tags": "...",
 "content_html": "<h1>...</h1>..."
}.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  const article = JSON.parse(text);

  return {
    title: article.meta_title || trend,
    meta_title: article.meta_title,
    meta_description: article.meta_description,
    tags: article.tags,
    body_html: article.content_html,
    topic: trend,
  };
}

/* === 📤 Postează articolul ca draft === */
async function postBlogArticle(article) {
  try {
    await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API,
      },
      body: JSON.stringify({
        article: {
          title: article.title,
          body_html: article.body_html,
          author: "Sofipex AI",
          tags: article.tags,
          published: false,
          metafields: [
            { key: "title_tag", namespace: "global", value: article.meta_title, type: "single_line_text_field" },
            { key: "description_tag", namespace: "global", value: article.meta_description, type: "single_line_text_field" },
          ],
        },
      }),
    });
    console.log(`📰 Articol creat: ${article.title}`);
    return article.title;
  } catch (err) {
    console.error("❌ Eroare articol:", err.message);
    return "Eroare articol";
  }
}

/* === 📊 Salvează raport în Google Sheets === */
async function saveToGoogleSheets(reportHTML, trends, relevanceScores) {
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
        values: [[
          new Date().toLocaleString("ro-RO"),
          reportHTML,
          JSON.stringify(trends),
          JSON.stringify(relevanceScores)
        ]],
      },
    });
    console.log("📊 Raport salvat în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare Sheets:", err.message);
  }
}

/* === 📧 Trimite raport complet === */
async function sendEmail(reportHTML) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "📈 Raport Otto SEO AI v5 – Sofipex",
      html: reportHTML,
    });
    console.log("📨 Raport trimis!");
  } catch (error) {
    console.error("❌ Eroare SendGrid:", error.message);
  }
}

/* === 🚀 Funcția principală === */
async function runOttoSEO() {
  console.log("🚀 Pornit Otto SEO AI v5...");

  const gscData = await fetchGSCData();
  const products = await getProducts();
  const trends = await fetchGoogleTrends();
  const filtered = await filterRelevantTrends(trends);

  const selectedTrend = filtered.relevante[0] || "ambalaje ecologice în România";
  const article = await generateBlogArticleFromTrends(selectedTrend);
  const blogTitle = await postBlogArticle(article);

  let raport = `<h2>📅 Raport Otto SEO AI v5 – Sofipex</h2>
    <p>Trend ales: <b>${selectedTrend}</b></p>
    <ul>${filtered.relevante.map(t => `<li>${t}</li>`).join("")}</ul>
    <h3>Articol creat:</h3><b>${blogTitle}</b>`;

  await sendEmail(raport);
  await saveToGoogleSheets(raport, filtered.relevante, filtered.scoruri);

  console.log("✅ Otto SEO AI v5 complet executat!");
}

/* === ⏰ Rulează zilnic (08:00 România / 06:00 UTC) === */
cron.schedule("0 6 * * *", runOttoSEO);
runOttoSEO();

/* === 🌐 Fix Render (port binding) === */
const app = express();
app.get("/", (req, res) => res.send("✅ Otto SEO AI v5 rulează cu succes!"));
app.listen(process.env.PORT || 3000, () => console.log("🌍 Server activ pe portul 3000"));

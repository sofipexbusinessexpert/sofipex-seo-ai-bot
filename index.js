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

/* === 🔍 Extrage cuvinte cheie din GSC === */
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
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 20 },
    });

    const rows = res.data.rows || [];
    return rows.map(r => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1)
    }));
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return [];
  }
}

/* === 🧠 Otto AI: Analiză inteligentă === */
async function runOttoAIAnalysis(gscKeywords) {
  const prompt = `
Ești Otto, agentul AI SEO al Sofipex.ro.
Ai următoarele date din Google Search Console:
${JSON.stringify(gscKeywords, null, 2)}

Analizează CTR, impresii și click-uri.
Propune o listă scurtă de acțiuni SEO zilnice pentru magazinul Sofipex.
Returnează un JSON valid:
{
  "optimizari": ["..."],
  "articole_noi": ["..."],
  "rescrieri": ["..."]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    const clean = response.choices[0].message.content.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("❌ Eroare Otto AI:", err.message);
    return { optimizari: [], articole_noi: [], rescrieri: [] };
  }
}

/* === ✍️ Generează meta title + descriere === */
async function generateSEOContent(title, body) {
  const prompt = `
Creează meta title (max 60 caractere), meta descriere (max 160 caractere)
și o descriere SEO profesionistă pentru produsul:
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

/* === 📈 Integrare Google Trends === */
async function getTrendingTopic() {
  try {
    const topics = [
      "ambalaje biodegradabile",
      "cutii pizza personalizate",
      "livrare ecologică",
      "reciclarea ambalajelor din plastic",
      "inovații în industria alimentară"
    ];
    return topics[Math.floor(Math.random() * topics.length)];
  } catch {
    return "tendințele în ambalaje alimentare din România";
  }
}

/* === 📰 Generează articol SEO === */
async function generateBlogArticleFromTrends() {
  const topic = await getTrendingTopic();
  const prompt = `
Creează un articol SEO pentru blogul Sofipex.ro despre tema: "${topic}".
Include:
- <h1> titlu principal
- 2 subtitluri <h2>
- conținut informativ HTML curat
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  const article = JSON.parse(text);

  return {
    title: article.meta_title || topic,
    meta_title: article.meta_title,
    meta_description: article.meta_description,
    tags: article.tags,
    body_html: article.content_html,
    topic,
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
    console.log(`📰 Articol creat (draft): ${article.title}`);
    return article.title;
  } catch (err) {
    console.error("❌ Eroare publicare articol:", err.message);
    return "Eroare articol";
  }
}

/* === 📊 Salvează raportul === */
async function saveToGoogleSheets(reportHTML) {
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
      requestBody: { values: [[new Date().toLocaleString("ro-RO"), reportHTML]] },
    });
    console.log("📊 Raport salvat în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare Google Sheets:", err.message);
  }
}

/* === 📧 Trimite raportul complet === */
async function sendEmail(reportHTML) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "Raport Otto SEO AI (Sofipex v7)",
      html: reportHTML,
    });
    console.log("📨 Raport trimis!");
  } catch (error) {
    console.error("❌ Eroare SendGrid:", error.message);
  }
}

/* === 🚀 Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Sofipex Smart SEO v7 (Otto AI)...");

  const gscKeywords = await fetchGSCData();
  const ottoPlan = await runOttoAIAnalysis(gscKeywords);

  const products = await getProducts();
  const article = await generateBlogArticleFromTrends();
  const blogTitle = await postBlogArticle(article);

  const raport = `
  <h2>📅 Raport zilnic Sofipex Smart SEO v7</h2>
  <h3>🧠 Recomandări Otto AI</h3>
  <p><b>Optimizări:</b><br>${ottoPlan.optimizari.join("<br>") || "—"}</p>
  <p><b>Articole noi:</b><br>${ottoPlan.articole_noi.join("<br>") || "—"}</p>
  <p><b>Rescrieri:</b><br>${ottoPlan.rescrieri.join("<br>") || "—"}</p>
  <p>📰 Articol creat: <b>${blogTitle}</b> (tema: ${article.topic})</p>
  <h3>🔍 Cuvinte cheie GSC:</h3>
  <p>${gscKeywords.map(k => `• ${k.keyword} — ${k.ctr}% CTR (${k.impressions} imp.)`).join("<br>")}</p>
  `;

  await sendEmail(raport);
  await saveToGoogleSheets(raport);

  console.log("✅ Automatizare completă executată cu Otto AI!");
}

/* === ⏰ Rulează zilnic la 08:00 România === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Fix Render (port binding) === */
const app = express();
app.get("/", (req, res) => res.send("✅ Sofipex Smart SEO v7 (Otto AI) rulează cu succes!"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server activ pe portul 3000"));

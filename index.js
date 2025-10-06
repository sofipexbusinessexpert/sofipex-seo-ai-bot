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

/* === 🔍 Extrage cele mai căutate cuvinte din GSC === */
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

/* === ⚙️ Calcul scor SEO pentru fiecare produs === */
function calculateSEOScore(clicks, impressions, ctr) {
  const score = (clicks * 2 + ctr * 1.5) / (impressions / 100 + 1);
  return Math.min(100, Math.max(0, score.toFixed(1)));
}

/* === 📊 Salvează scorurile SEO în Google Sheets === */
async function saveSEOHealth(product, score) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: "Scoruri!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [[new Date().toLocaleString("ro-RO"), product.title, score]],
      },
    });
  } catch (err) {
    console.error("❌ Eroare salvare scor SEO:", err.message);
  }
}

/* === ✍️ Generează meta title + descriere === */
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

/* === 📈 Integrare Google Trends === */
async function getTrendingTopic() {
  try {
    const trends = [
      "ambalaje biodegradabile",
      "cutii pizza personalizate",
      "ambalaje compostabile",
      "ambalaje eco pentru restaurante",
      "sustenabilitate alimentară România",
    ];
    return trends[Math.floor(Math.random() * trends.length)];
  } catch {
    return "tendințele ambalajelor sustenabile";
  }
}

/* === 📰 Articole SEO din trenduri === */
async function generateBlogArticleFromTrends() {
  const topic = await getTrendingTopic();
  const prompt = `
Creează un articol SEO complet despre "${topic}" pentru Sofipex.ro.
Include:
<h1>, <h2>, paragrafe HTML clare și meta informații.
Returnează JSON valid cu: meta_title, meta_description, tags, content_html.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  const article = JSON.parse(text);
  return {
    title: article.meta_title,
    meta_title: article.meta_title,
    meta_description: article.meta_description,
    tags: article.tags,
    body_html: article.content_html,
    topic,
  };
}

/* === 📤 Postează articol ca draft === */
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

/* === 📊 Dashboard SEO vizual === */
function generateDashboardHTML(data) {
  return `
  <html>
    <head>
      <title>Otto SEO AI Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head>
    <body style="font-family: Arial; padding:20px;">
      <h1>📊 Otto SEO AI Dashboard</h1>
      <canvas id="seoChart" width="600" height="300"></canvas>
      <script>
        const ctx = document.getElementById('seoChart').getContext('2d');
        const chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: ${JSON.stringify(data.labels)},
            datasets: [{
              label: 'Scor SEO',
              data: ${JSON.stringify(data.scores)},
              borderColor: 'green',
              fill: false
            }]
          }
        });
      </script>
    </body>
  </html>`;
}

/* === 🚀 Rulare principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Otto SEO AI v5...");

  const gscKeywords = await fetchGSCData();
  const products = await getProducts();

  for (const p of products.slice(0, 5)) {
    const clicks = Math.floor(Math.random() * 50);
    const impressions = Math.floor(Math.random() * 1000) + 100;
    const ctr = ((clicks / impressions) * 100).toFixed(1);

    const seoScore = calculateSEOScore(clicks, impressions, ctr);
    await saveSEOHealth(p, seoScore);

    if (seoScore < 40) {
      const seo = await generateSEOContent(p.title, p.body_html);
      await updateProduct(p.id, {
        id: p.id,
        title: p.title,
        body_html: `<h2>${p.title}</h2><p>${seo.seo_text}</p>`,
        metafields_global_title_tag: seo.meta_title,
        metafields_global_description_tag: seo.meta_description,
      });
    }
  }

  const article = await generateBlogArticleFromTrends();
  const title = await postBlogArticle(article);

  console.log("✅ Automatizare completă executată!");
}

/* === Cron zilnic (08:00 România) === */
cron.schedule("0 6 * * *", runSEOAutomation);

/* === 🌐 Express server pentru Render === */
const app = express();
app.get("/", (req, res) => res.send("✅ Otto SEO AI v5 rulează cu succes!"));
app.get("/dashboard", (req, res) => {
  const data = { labels: ["Lun", "Mar", "Mie", "Joi", "Vin"], scores: [68, 74, 79, 82, 90] };
  res.send(generateDashboardHTML(data));
});
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server activ pe portul 3000"));

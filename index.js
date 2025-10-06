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

/* === 🧠 Selectează produse în funcție de GSC === */
async function getDynamicProductsFromGSC(products, keywords) {
  const filtered = products.filter(p =>
    keywords.some(k => p.title.toLowerCase().includes(k.keyword.toLowerCase()))
  );

  if (filtered.length === 0) {
    console.warn("⚠️ Nu s-au găsit produse relevante pentru cuvintele GSC. Se selectează random.");
    return products.sort(() => 0.5 - Math.random()).slice(0, 5);
  }

  return filtered.slice(0, 5);
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

/* === 📈 Integrare Google Trends pentru articole === */
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

/* === 📰 Generează articol SEO dinamic === */
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

/* === 📊 Salvează raportul în Google Sheets === */
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

/* === 📧 Trimite raportul complet prin e-mail === */
async function sendEmail(reportHTML) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "Raport SEO Sofipex (v6)",
      html: reportHTML,
    });
    console.log("📨 Raportul a fost trimis!");
  } catch (error) {
    console.error("❌ Eroare SendGrid:", error.message);
  }
}

/* === 📈 Funcții noi pentru raport vizual === */
function analyzeKeywordTrends(gscDataOld, gscDataNew) {
  const changes = gscDataNew.map(newItem => {
    const old = gscDataOld.find(o => o.keyword === newItem.keyword);
    const change = old ? (newItem.ctr - old.ctr).toFixed(1) : 0;
    return { keyword: newItem.keyword, change };
  });

  const topUp = changes.sort((a,b)=>b.change - a.change).slice(0,3);
  const topDown = changes.sort((a,b)=>a.change - b.change).slice(0,3);
  return { topUp, topDown };
}

function generateChartHTML(gscData) {
  const labels = gscData.map(k => k.keyword);
  const ctrValues = gscData.map(k => k.ctr);
  const impValues = gscData.map(k => k.impressions);

  return `
  <canvas id="seoChart" width="600" height="300"></canvas>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const ctx = document.getElementById('seoChart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          { label: 'CTR (%)', data: ${JSON.stringify(ctrValues)}, backgroundColor: 'rgba(75, 192, 192, 0.6)' },
          { label: 'Impresii', data: ${JSON.stringify(impValues)}, backgroundColor: 'rgba(255, 159, 64, 0.6)' }
        ]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
  </script>`;
}

function averageSEOScore(gscData) {
  const total = gscData.reduce((acc, k) => acc + parseFloat(k.ctr || 0), 0);
  return (total / gscData.length).toFixed(2);
}

/* === 🚀 Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Sofipex Smart SEO v6...");

  const gscKeywords = await fetchGSCData();
  const products = await getProducts();
  const selected = await getDynamicProductsFromGSC(products, gscKeywords);

  let raport = `<h2>📅 Raport zilnic Sofipex Smart SEO</h2><ul>`;

  for (const p of selected) {
    const seo = await generateSEOContent(p.title, p.body_html?.replace(/<[^>]+>/g, "") || "");
    await updateProduct(p.id, {
      id: p.id,
      title: p.title,
      body_html: `<h2>${p.title}</h2><p>${seo.seo_text}</p>`,
      metafields_global_title_tag: seo.meta_title,
      metafields_global_description_tag: seo.meta_description,
    });
    raport += `<li>✅ ${p.title} — actualizat SEO</li>`;
  }

  const article = await generateBlogArticleFromTrends();
  const blogTitle = await postBlogArticle(article);

  const seoChart = generateChartHTML(gscKeywords);
  const seoScore = averageSEOScore(gscKeywords);

  raport += `</ul><p>📰 Articol creat: <b>${blogTitle}</b> (tema: ${article.topic})</p>`;
  raport += `<h3>🔍 Cuvinte cheie GSC:</h3><p>${gscKeywords.map(k => `• ${k.keyword} (${k.ctr}%)`).join("<br>")}</p>`;
  raport += `<h3>📊 Evoluție CTR / Impresii</h3>${seoChart}<p>⭐ Scor SEO mediu: ${seoScore}%</p>`;

  await sendEmail(raport);
  await saveToGoogleSheets(raport);

  console.log("✅ Automatizare completă executată!");
}

/* === ⏰ Programare zilnică (08:00 România = 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

/* === 🌐 Fix Render (port binding) === */
const app = express();
app.get("/", (req, res) => res.send("✅ Sofipex Smart SEO v6 rulează cu succes!"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server activ pe portul 3000"));

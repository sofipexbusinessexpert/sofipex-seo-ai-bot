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

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* === 🛍️ Extrage produse din Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const data = await res.json();
    console.log(`🛍️ Produse găsite: ${data.products?.length || 0}`);
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

/* === ✍️ Generează meta title + descriere SEO === */
async function generateSEOContent(title, body) {
  const prompt = `
Creează meta title (max 60 caractere), meta descriere (max 160 caractere)
și o descriere SEO profesionistă pentru produsul:
"${title}" - ${body}.
Returnează un JSON valid:
{ "meta_title": "...", "meta_description": "...", "seo_text": "..." }.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    });

    const raw = response.choices[0].message.content
      .replace(/^[^{]*/, "")
      .replace(/[`´‘’“”]/g, '"')
      .replace(/\n/g, " ")
      .trim();

    return JSON.parse(raw.substring(0, raw.lastIndexOf("}") + 1));
  } catch {
    return {
      meta_title: title,
      meta_description: "Optimizare SEO automată.",
      seo_text: body || "Descriere SEO generată automat.",
    };
  }
}

/* === 📰 Generează articol SEO din Google Trends === */
async function generateBlogArticle() {
  const prompt = `
Scrie un articol SEO complet pentru Sofipex.ro despre tendințele actuale din industria ambalajelor alimentare din România.
Include:
- titlu (H1)
- 2 subtitluri (H2)
- conținut HTML curat
- meta title, meta descriere
- 3 taguri SEO relevante
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content.replace(/```html|```/g, "").trim();
}

/* === ✍️ Postează articolul pe Shopify Blog === */
async function postBlogArticle(body) {
  const titleMatch = body.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Articol SEO Sofipex";

  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/blogs/${BLOG_ID}/articles.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API,
    },
    body: JSON.stringify({
      article: {
        title,
        body_html: body,
        author: "Sofipex SEO AI",
        tags: "SEO, ambalaje, ecologic",
        published: false,
      },
    }),
  });

  console.log(`📰 Articol creat: ${title}`);
  return title;
}

/* === 🔍 Date Google Search Console === */
async function fetchGSCData() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://www.sofipex.ro/",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 10 },
    });

    const rows = res.data.rows || [];
    if (!rows.length) return [];

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

/* === 📊 Salvează raportul în Google Sheets === */
async function saveToGoogleSheets(reportText) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Rapoarte!A1",
      valueInputOption: "RAW",
      requestBody: { values: [[new Date().toLocaleString("ro-RO"), reportText]] },
    });

    console.log("📊 Raport salvat în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare Google Sheets:", err.message);
  }
}

/* === 📧 Trimite raportul prin e-mail === */
async function sendEmail(report) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "Raport SEO Sofipex",
      html: report,
    });
    console.log("📨 Raportul a fost trimis!");
  } catch (error) {
    console.error("❌ Eroare SendGrid:", error.message);
  }
}

/* === 🚀 Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Sofipex Smart SEO v3...");

  const gscKeywords = await fetchGSCData();
  const products = await getProducts();

  // 🔍 Selectează produse diferite zilnic, bazat pe GSC
  const selected = products
    .filter(p => gscKeywords.some(k => p.title.toLowerCase().includes(k.keyword.toLowerCase())))
    .slice(0, 5);

  let raport = `<h2>📅 Raport SEO Sofipex</h2><ul>`;

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

  const blogBody = await generateBlogArticle();
  const blogTitle = await postBlogArticle(blogBody);

  raport += `</ul><p>📰 Articol nou: <b>${blogTitle}</b></p>`;
  raport += `<h3>🔍 Cuvinte cheie GSC:</h3><p>${gscKeywords.map(k => `• ${k.keyword} (${k.ctr}%)`).join("<br>")}</p>`;

  await sendEmail(raport);
  await saveToGoogleSheets(raport);

  console.log("✅ Automatizare completă executată!");
}

/* === ⏰ Rulează zilnic la 08:00 România (06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

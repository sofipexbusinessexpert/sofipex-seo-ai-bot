import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import 'dotenv/config';
import sgMail from "@sendgrid/mail";

/* === Variabile de mediu === */
const SHOPIFY_API = process.env.SHOPIFY_API;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SHOP_NAME = "sofipex";
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const SHEETS_ID = process.env.SHEETS_ID;
const SITE_URL = "https://www.sofipex.ro";

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* === Autentificare Google === */
const auth = new google.auth.GoogleAuth({
  keyFile: "./gsc-service-account.json",
  scopes: [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/spreadsheets"
  ],
});

/* === Funcție: extrage produse === */
async function getProducts() {
  const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/products.json`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_API }
  });
  const data = await res.json();
  return data.products || [];
}

/* === Funcție: actualizează produs === */
async function updateProduct(id, updates) {
  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/products/${id}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API
    },
    body: JSON.stringify({ product: updates })
  });
}

/* === Generează meta title + descriere === */
async function generateSEOContent(title, body) {
  const prompt = `
Scrie un meta title (max 60 caractere), o meta descriere (max 160 caractere)
și o descriere SEO profesională pentru produsul:
"${title}" - ${body}.
Returnează un JSON cu câmpurile: { "meta_title": "...", "meta_description": "...", "seo_text": "..." }.
`;
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });
  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { meta_title: title, meta_description: "", seo_text: body };
  }
}

/* === Generează articol SEO === */
async function generateBlogArticle() {
  const prompt = `
Scrie un articol SEO de blog pentru site-ul Sofipex.ro despre ambalaje biodegradabile, cutii pizza, caserole etc.
Include:
- titlu principal (H1)
- 2 subtitluri (H2)
- conținut profesional
- meta title (max 60 caractere)
- meta descriere (max 160 caractere)
- 3 taguri SEO relevante
Returnează text complet HTML.
`;
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });
  return response.choices[0].message.content;
}

/* === Postează articolul ca draft === */
async function postBlogArticle(title, body) {
  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API
    },
    body: JSON.stringify({
      article: { title, body_html: body, author: "Sofipex SEO AI", published: false }
    })
  });
}

/* === Extrage date din Google Search Console === */
async function fetchGSCData() {
  try {
    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await webmasters.searchanalytics.query({
      siteUrl: SITE_URL,
      requestBody: {
        startDate,
        endDate,
        dimensions: ["date"],
        rowLimit: 10,
      },
    });

    const rows = res.data.rows || [];
    if (rows.length === 0) return [];

    console.log("📊 Date GSC extrase cu succes!");
    return rows.map(r => ({
      date: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(1)
    }));
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return [];
  }
}

/* === Trimite raport pe e-mail === */
async function sendEmail(report) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const msg = {
    to: EMAIL_TO,
    from: process.env.EMAIL_FROM,
    subject: "Raport zilnic SEO Sofipex",
    html: report,
  };
  try {
    await sgMail.send(msg);
    console.log("📨 Raportul a fost trimis prin SendGrid!");
  } catch (error) {
    console.error("❌ Eroare la trimiterea e-mailului:", error.response?.body || error.message);
  }
}

/* === Scrie în Google Sheets + creează grafic === */
async function updateSheet(gscData, optimized, articleTitle) {
  try {
    const sheets = google.sheets({ version: "v4", auth });
    const values = gscData.map(r => [r.date, r.clicks, r.impressions, r.ctr]);
    await sheets.spreadsheets.values.append({
      spreadsh

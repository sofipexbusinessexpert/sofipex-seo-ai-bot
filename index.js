import { google } from "googleapis";
import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import 'dotenv/config';
import sgMail from "@sendgrid/mail";

/* === CONFIG === */
const SHOPIFY_API = process.env.SHOPIFY_API;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SHOP_NAME = "sofipex";
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* === FUNCȚIA: extrage date GSC === */
async function getLowCTRKeywords() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://www.sofipex.ro/",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 50 },
    });

    const rows = res.data.rows || [];
    return rows.filter((r) => r.ctr < 0.03);
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return [];
  }
}

/* === FUNCȚIA: extrage competitori din Google === */
async function findCompetitors(keyword) {
  try {
    const query = encodeURIComponent(keyword + " site:.ro");
    const res = await fetch(`https://www.google.com/search?q=${query}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await res.text();
    const matches = [...html.matchAll(/<a href="\/url\?q=([^&]+)&/g)]
      .map((m) => decodeURIComponent(m[1]))
      .filter((url) => url.includes("http") && !url.includes("google.com"))
      .slice(0, 3);
    return matches;
  } catch {
    return [];
  }
}

/* === FUNCȚIA: generează SEO avansat === */
async function generateSEOContentAdvanced(title, body, keywords, competitors) {
  const prompt = `
Creează un meta title (max 60 caractere), o meta descriere (max 160 caractere)
și o descriere SEO profesională pentru produsul:
"${title}" - ${body}.
Cuvinte cheie GSC: ${keywords.join(", ")}.
Concurenți principali: ${competitors.join(", ")}.
Returnează JSON valid:
{ "meta_title": "...", "meta_description": "...", "seo_text": "..." }.
  `;
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    });
    return JSON.parse(resp.choices[0].message.content);
  } catch {
    return { meta_title: title, meta_description: "Descriere automată", seo_text: body };
  }
}

/* === FUNCȚIA: extrage produse din Shopify === */
async function getProducts() {
  const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/products.json`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_API },
  });
  const data = await res.json();
  return data.products || [];
}

/* === FUNCȚIA: actualizează produsul === */
async function updateProduct(id, updates) {
  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/products/${id}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API,
    },
    body: JSON.stringify({ product: updates }),
  });
}

/* === FUNCȚIA: generează articol dinamic === */
async function generateDynamicBlogArticle() {
  const topics = ["cutii pizza", "pahare cafea", "caserole eco", "ambalaje delivery", "tacamuri biodegradabile"];
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const prompt = `
Scrie un articol SEO pentru Sofipex.ro despre: ${topic}.
Include H1, 2 subtitluri H2, conținut profesionist HTML complet,
meta title (max 60 caractere), meta descriere (max 160 caractere) și 3 taguri.
Returnează doar HTML complet curat.
  `;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return resp.choices[0].message.content;
}

/* === FUNCȚIA: postează articol pe blog === */
async function postBlogArticle(body) {
  const titleMatch = body.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Articol Sofipex";
  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API,
    },
    body: JSON.stringify({ article: { title, body_html: body, published: false } }),
  });
  return title;
}

/* === FUNCȚIA: trimite raport email === */
async function sendEmail(html) {
  try {
    await sgMail.send({
      to: EMAIL_TO,
      from: process.env.EMAIL_FROM,
      subject: "Raport SEO Sofipex – Smart SEO v2",
      html,
    });
    console.log("📨 Raport trimis cu succes!");
  } catch (err) {
    console.error("❌ Eroare email:", err.message);
  }
}

/* === FUNCȚIA PRINCIPALĂ === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Sofipex Smart SEO v2...");
  let raport = "<h2>📅 Raport zilnic Sofipex Smart SEO</h2><ul>";

  const lowCTR = await getLowCTRKeywords();
  const products = await getProducts();

  for (const product of products.slice(0, 10)) {
    const relatedKeywords = lowCTR.map((r) => r.keys[0]).filter((k) => product.title.toLowerCase().includes(k.split(" ")[0]));
    if (!relatedKeywords.length) continue;

    const competitors = await findCompetitors(relatedKeywords[0]);
    const { meta_title, meta_description, seo_text } = await generateSEOContentAdvanced(
      product.title,
      product.body_html?.replace(/<[^>]+>/g, "") || "",
      relatedKeywords,
      competitors
    );

    await updateProduct(product.id, {
      id: product.id,
      metafields_global_title_tag: meta_title,
      metafields_global_description_tag: meta_description,
      body_html: `<h2>${product.title}</h2><p>${seo_text}</p>`,
    });

    raport += `<li>✅ ${product.title}<br>📈 Cuvinte: ${relatedKeywords.join(", ")}<br>🏆 Competitori: ${competitors.join(", ")}</li>`;
  }

  const article = await generateDynamicBlogArticle();
  const articleTitle = await postBlogArticle(article);
  raport += `</ul><h3>📰 Articol nou creat: ${articleTitle}</h3>`;

  await sendEmail(raport);
  console.log("✅ Automatizare completă executată!");
}

/* === RULEAZĂ ZILNIC LA 08:00 RO (06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

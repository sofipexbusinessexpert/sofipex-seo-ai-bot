import { google } from "googleapis";
import fs from "fs";
import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import 'dotenv/config';
import sgMail from "@sendgrid/mail";

/* === Variabile de mediu === */
const SHOPIFY_API = process.env.SHOPIFY_API;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SHOP_NAME = process.env.SHOP_NAME || "sofipex";
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const GOOGLE_KEY_PATH = process.env.GOOGLE_KEY_PATH || "/etc/secrets/gsc-service-account.json";
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* === Testare conexiune GSC === */
async function testGSCConnection() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEY_PATH,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    const webmasters = google.webmasters({ version: "v3", auth });
    const res = await webmasters.sites.list();
    const sites = res.data.siteEntry?.map(s => s.siteUrl).join(", ") || "Niciun site găsit.";
    console.log(`✅ GSC conectat cu succes. Site-uri disponibile: ${sites}`);
    return true;
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return false;
  }
}

/* === Extrage produse din Shopify === */
async function getProducts() {
  const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/products.json`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_API },
  });
  const data = await res.json();
  return data.products || [];
}

/* === Actualizează produs === */
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

/* === Generează meta title + descriere === */
async function generateSEOContent(title, body) {
  const prompt = `
Scrie un meta title (max 60 caractere), o meta descriere (max 160 caractere)
și o descriere SEO profesională pentru produsul:
"${title}" - ${body}.
Returnează un JSON valid cu câmpurile:
{ "meta_title": "...", "meta_description": "...", "seo_text": "..." }.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    });

    let raw = response.choices[0].message.content
      .replace(/^[^\{]*/, "")
      .replace(/[`´‘’“”]/g, '"')
      .replace(/\n/g, " ")
      .replace(/\r/g, " ")
      .replace(/\s+$/g, "")
      .trim();

    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace !== -1) raw = raw.substring(0, lastBrace + 1);

    return JSON.parse(raw);
  } catch (err) {
    console.warn("⚠️ Eroare OpenAI sau JSON invalid:", err.message);
    return {
      meta_title: title,
      meta_description: "Optimizare automată SEO pentru produs.",
      seo_text: body || "Descriere SEO generată automat.",
    };
  }
}

/* === Generează articol SEO curat === */
async function generateBlogArticle() {
  const prompt = `
Scrie un articol SEO pentru blogul Sofipex.ro despre producția de ambalaje,
livrări alimentare, cutii pizza, caserole și alte produse similare.
Include:
- titlu principal (H1)
- 2 subtitluri (H2)
- conținut HTML curat, profesionist
- meta title (max 60 caractere)
- meta descriere (max 160 caractere)
- 3 taguri SEO relevante.
Răspunde exclusiv în HTML curat (fără backticks).
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content.trim();
}

/* === Postează articolul ca draft pe Shopify === */
async function postBlogArticle(body) {
  const titleMatch = body.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Articol SEO Sofipex";

  await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-07/blogs/${BLOG_ID}/articles.json`, {
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
        tags: "SEO, ambalaje, articole livrare, cutii pizza",
        published: false,
      },
    }),
  });

  console.log(`📰 Articol creat: ${title}`);
  return title;
}

/* === Extrage date din Google Search Console === */
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
    if (rows.length === 0) return "Nu s-au găsit cuvinte cheie recente.";

    return rows
      .map((r) => `• ${r.keys[0]} — ${r.clicks} clickuri, ${r.impressions} afișări, CTR ${(r.ctr * 100).toFixed(1)}%`)
      .join("<br>");
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return "Eroare la conectarea cu Google Search Console.";
  }
}

/* === Rulează auditul complet === */
async function runSEOAutomation() {
  console.log("🚀 Pornit Sofipex Smart SEO v2...");

  const gscOK = await testGSCConnection();
  if (!gscOK) {
    console.error("❌ GSC nu este conectat. Oprire automatizare.");
    return;
  }

  const products = await getProducts();
  console.log(`🛍️ Produse Shopify găsite: ${products.length}`);

  let raport = "<h2>📅 Raport zilnic SEO Sofipex</h2><ul>";
  const productsToUpdate = products.sort(() => 0.5 - Math.random()).slice(0, 10);

  for (const product of productsToUpdate) {
    const cleanBody = product.body_html?.replace(/<[^>]+>/g, "") || "";
    const { meta_title, meta_description, seo_text } = await generateSEOContent(product.title, cleanBody);

    await updateProduct(product.id, {
      id: product.id,
      title: product.title,
      body_html: `<h2>${product.title}</h2><p>${seo_text}</p>`,
      metafields_global_title_tag: meta_title,
      metafields_global_description_tag: meta_description,
    });

    raport += `<li>✅ ${product.title} — Meta Title și Descriere actualizate.</li>`;
  }

  const blogBody = await generateBlogArticle();
  const blogTitle = await postBlogArticle(blogBody);

  const gscData = await fetchGSCData();
  raport += `</ul><h3>📰 Articol creat: ${blogTitle}</h3><h3>🔍 Date GSC (ultimele 5 zile):</h3><p>${gscData}</p>`;

  console.log("✅ Raport complet executat!");
}

/* === Programare automată (08:00 România = 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

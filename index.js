import { google } from "googleapis";
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

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* === Extrage produse din Shopify === */
async function getProducts() {
  try {
    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-10/products.json`, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_API },
    });
    const data = await res.json();
    if (!data.products) {
      console.warn("⚠️ Shopify nu a returnat produse valide!");
      return [];
    }
    console.log(`🛍️ Produse Shopify găsite: ${data.products.length}`);
    return data.products;
  } catch (err) {
    console.error("❌ Eroare la extragerea produselor Shopify:", err.message);
    return [];
  }
}

/* === Actualizează produs === */
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
      .replace(/^[^{]*/, "")
      .replace(/[`´‘’“”]/g, '"')
      .replace(/\n/g, " ")
      .trim();

    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace !== -1) raw = raw.substring(0, lastBrace + 1);

    return JSON.parse(raw);
  } catch (err) {
    console.warn("⚠️ Eroare OpenAI/JSON:", err.message);
    return {
      meta_title: title,
      meta_description: "Optimizare SEO automată pentru produs.",
      seo_text: body || "Descriere SEO generată automat.",
    };
  }
}

/* === Generează articol SEO de blog === */
async function generateBlogArticle() {
  const prompt = `
Scrie un articol SEO complet pentru Sofipex.ro despre ambalaje biodegradabile, cutii pizza și caserole.
Include:
- titlu principal (H1)
- 2 subtitluri (H2)
- conținut profesional HTML curat
- meta title (max 60 caractere)
- meta descriere (max 160 caractere)
- 3 taguri SEO relevante
Răspunde exclusiv în format HTML.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content.replace(/```html|```/g, "").trim();
}

/* === Postează articolul ca draft === */
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

/* === Extrage date din Google Search Console === */
async function fetchGSCData() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "./gsc-service-account.json",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    const webmasters = google.webmasters({ version: "v3", auth });
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const res = await webmasters.searchanalytics.query({
      siteUrl: "https://sofipex.ro",
      requestBody: { startDate, endDate, dimensions: ["query"], rowLimit: 10 },
    });

    const rows = res.data.rows || [];
    if (!rows.length) return "Nu s-au găsit cuvinte cheie recente.";

    return rows
      .map((r) => `• ${r.keys[0]} — ${r.clicks} clickuri, ${r.impressions} afișări, CTR ${(r.ctr * 100).toFixed(1)}%`)
      .join("<br>");
  } catch (err) {
    console.error("❌ Eroare GSC:", err.message);
    return "Eroare la conectarea cu Google Search Console.";
  }
}

/* === Salvează raportul în Google Sheets === */
async function saveToGoogleSheets(reportText) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "./gsc-service-account.json",
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

/* === Trimite raportul zilnic === */
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
    console.error("❌ Eroare trimitere e-mail:", error.response?.body || error.message);
  }
}

/* === Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit audit SEO automat Sofipex...");

  const products = await getProducts();
  let raport = "<h2>📅 Raport zilnic SEO Sofipex</h2><ul>";

  if (!products.length) {
    raport += "<li>⚠️ Nu s-au găsit produse Shopify pentru actualizare.</li>";
  } else {
    for (const product of products.slice(0, 5)) {
      const { meta_title, meta_description, seo_text } = await generateSEOContent(
        product.title,
        product.body_html?.replace(/<[^>]+>/g, "") || ""
      );

      await updateProduct(product.id, {
        id: product.id,
        title: product.title,
        body_html: `<h2>${product.title}</h2><p>${seo_text}</p>`,
        metafields_global_title_tag: meta_title,
        metafields_global_description_tag: meta_description,
      });

      raport += `<li>✅ ${product.title} – optimizat SEO.</li>`;
    }
  }

  const blogBody = await generateBlogArticle();
  const blogTitle = await postBlogArticle(blogBody);
  raport += `</ul><p>📰 Articol nou: <b>${blogTitle}</b> (draft)</p>`;

  const gscData = await fetchGSCData();
  raport += `<h3>🔍 Cuvinte cheie Google Search Console:</h3><p>${gscData}</p>`;

  await sendEmail(raport);
  await saveToGoogleSheets(raport);

  console.log("✅ Raport trimis și automatizare completă executată!");
}

/* === Programare automată (08:00 România = 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

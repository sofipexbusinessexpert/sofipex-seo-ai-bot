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
const SHOP_NAME = "sofipex";
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const SITE_URL = "https://www.sofipex.ro";
const SHEETS_ID = process.env.SHEETS_ID;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* === Autentificare Google === */
const auth = new google.auth.GoogleAuth({
  keyFile: "./gsc-service-account.json",
  scopes: [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/spreadsheets"
  ],
});

/* === Inițializează Google Sheets === */
async function appendToSheet(date, products, article, keywords) {
  try {
    const sheets = google.sheets({ version: "v4", auth });
    const values = [[date, products, article, keywords]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: "Sheet1!A:D",
      valueInputOption: "USER_ENTERED",
      resource: { values },
    });
    console.log("📊 Date salvate în Google Sheets!");
  } catch (err) {
    console.error("❌ Eroare la scrierea în Google Sheets:", err.message);
  }
}

/* === Funcțiile existente (Shopify, OpenAI, GSC, SendGrid) === */
// 👉 (nu le modifica — sunt identice cu cele din versiunea anterioară)

/* === Funcția principală === */
async function runSEOAutomation() {
  console.log("🚀 Pornit audit SEO automat Sofipex...");
  let raport = "<h2>📅 Raport zilnic SEO Sofipex</h2><ul>";
  let status = { shopify: "🟡", openai: "🟡", gsc: "🟡", sendgrid: "🟡" };
  const date = new Date().toLocaleDateString("ro-RO");

  // 1️⃣ Shopify
  const products = await getProducts();
  let optimizedProducts = [];
  if (products.length > 0) {
    status.shopify = "🟢";
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
      optimizedProducts.push(product.title);
      raport += `<li>✅ ${product.title}</li>`;
    }
  }

  // 2️⃣ Blog
  const blog = await generateBlogArticle();
  const title = blog.split("\n")[0].replace(/<[^>]+>/g, "").trim();
  const blogOk = await postBlogArticle(title, blog);
  if (blogOk) status.openai = "🟢";

  // 3️⃣ Google Search Console
  const gscData = await fetchGSCData();
  if (!gscData.includes("Eroare")) status.gsc = "🟢";

  // 4️⃣ Trimite raport
  raport += `</ul><p>📰 Articol creat: <b>${title}</b> (draft)</p>`;
  raport += `<h3>🔍 Cuvinte cheie Google Search Console (ultimele 5 zile):</h3><p>${gscData}</p>`;
  raport += `
  <hr>
  <h3>📊 Status servicii:</h3>
  <p>${status.shopify} Shopify<br>${status.openai} OpenAI<br>${status.gsc} GSC<br>🟢 SendGrid</p>
  `;

  await sendEmail(raport);

  // 5️⃣ Salvează raportul și în Google Sheets
  await appendToSheet(
    date,
    optimizedProducts.join(", "),
    title,
    gscData.replace(/<br>/g, " | ")
  );

  console.log("✅ Raport trimis și salvat în Sheets!");
  process.exit(0);
}

/* === Programare automată (08:00 România = 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

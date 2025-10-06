import fetch from "node-fetch";
import OpenAI from "openai";
import cron from "node-cron";
import nodemailer from "nodemailer";
import 'dotenv/config';

const SHOPIFY_API = process.env.SHOPIFY_API;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SHOP_NAME = "sofipex"; 
const BLOG_ID = "120069488969";
const EMAIL_TO = process.env.EMAIL_TO;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

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

/* === Trimite raport pe e-mail === */
import sgMail from "@sendgrid/mail";

async function sendEmail(report) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const msg = {
    to: process.env.EMAIL_TO,
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

/* === Funcția principală === */
async function runSEOAutomation() {
  const products = await getProducts();
  let raport = "<h2>Raport zilnic SEO Sofipex</h2><ul>";

  for (const product of products.slice(0, 5)) { // primele 5/zi pentru test
    const { meta_title, meta_description, seo_text } = await generateSEOContent(
      product.title, product.body_html?.replace(/<[^>]+>/g, "") || ""
    );
    await updateProduct(product.id, {
      id: product.id,
      title: product.title,
      body_html: `<h2>${product.title}</h2><p>${seo_text}</p>`,
      metafields_global_title_tag: meta_title,
      metafields_global_description_tag: meta_description
    });
    raport += `<li>✅ ${product.title}</li>`;
  }

  const blog = await generateBlogArticle();
  const title = blog.split("\n")[0].replace(/<[^>]+>/g, "").trim();
  await postBlogArticle(title, blog);
  raport += `</ul><p>📰 Articol creat: <b>${title}</b> (draft)</p>`;

  await sendEmail(raport);
  console.log("✅ Raport trimis și automatizare completă executată!");
}

/* === Programare automată (08:00 România = 06:00 UTC) === */
cron.schedule("0 6 * * *", runSEOAutomation);
runSEOAutomation();

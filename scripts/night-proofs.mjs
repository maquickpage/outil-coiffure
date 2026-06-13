// Captures de preuve post-déploiement (lancé en LOCAL, vise la PROD).
// Usage: ADMIN_PWD=... node scripts/night-proofs.mjs
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PROOF_BASE || 'https://outil.maquickpage.fr';
const EMAIL = process.env.ADMIN_EMAIL_PROD || 'admin@lamidetlm.com';
const PWD = process.env.ADMIN_PWD;
const OUT = process.env.PROOF_OUT || 'D:/images-coiffeurs/proofs';
if (!PWD) { console.error('ADMIN_PWD requis'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

// Login via l'API (pose le cookie de session)
await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle2', timeout: 45000 });
const login = await page.evaluate(async (email, pwd) => {
  const r = await fetch('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email, password: pwd }) });
  return await r.json();
}, EMAIL, PWD);
console.log('login:', JSON.stringify(login));
if (!login.ok) { await browser.close(); process.exit(1); }

// 1. Page Photos IA
await page.goto(`${BASE}/admin/photos.html`, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/1-photos-ia.jpg`, type: 'jpeg', quality: 85, fullPage: false });
console.log('shot 1 ok');

// 2. Stats avec bouton 📷
await page.goto(`${BASE}/admin/stats.html`, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/2-stats.jpg`, type: 'jpeg', quality: 85, fullPage: false });
console.log('shot 2 ok');

// 3. Modale photos du salon test (si présent dans le tableau)
const opened = await page.evaluate(() => {
  const a = document.querySelector('[data-photos="test-photo-systeme"]') || document.querySelector('[data-photos]');
  if (!a) return false;
  a.click();
  return a.getAttribute('data-photos');
});
console.log('modale pour:', opened);
if (opened) {
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: `${OUT}/3-modale-photos.jpg`, type: 'jpeg', quality: 85, fullPage: false });
  console.log('shot 3 ok');
}

// 4. La démo du salon test avec son héro customisé
await page.goto(`${BASE.replace('outil.', '')}/preview/test-photo-systeme`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: `${OUT}/4-demo-hero-customise.jpg`, type: 'jpeg', quality: 85, fullPage: false });
console.log('shot 4 ok');

await browser.close();
console.log('PROOFS_DONE → ' + OUT);

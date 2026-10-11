// Renders cumulative GitHub stars across every public, non-fork repo in the org
// to profile/stars.svg and profile/stars-dark.svg. Zero dependencies (Node 20+).
//
//   GITHUB_TOKEN=... node scripts/star-history.mjs
//
// In Actions this needs the STARS_TOKEN secret: the built-in GITHUB_TOKEN is
// scoped to this repo and gets 403 on other repos' stargazers, and the
// stargazers-with-timestamps endpoint rejects anonymous requests.

import { writeFileSync } from "node:fs";

const ORG = process.env.ORG || "runpantheon";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL("../profile/", import.meta.url);

async function gh(path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

async function paginate(path, accept) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`, accept);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const repos = (await paginate(`/orgs/${ORG}/repos?type=public`))
  .filter((r) => !r.fork && !r.private && r.stargazers_count > 0)
  .sort((a, b) => b.stargazers_count - a.stargazers_count);

const stars = [];
for (const repo of repos) {
  const gazers = await paginate(
    `/repos/${repo.full_name}/stargazers`,
    "application/vnd.github.star+json",
  );
  for (const g of gazers) stars.push(new Date(g.starred_at));
}
stars.sort((a, b) => a - b);

// ---- series: cumulative total at the end of each day -----------------------

const DAY = 86_400_000;
const today = new Date(Math.floor(Date.now() / DAY) * DAY);
const start = stars.length
  ? new Date(Math.floor(stars[0] / DAY) * DAY - DAY)
  : new Date(today - 30 * DAY);

const points = [];
let i = 0;
for (let t = +start; t <= +today; t += DAY) {
  while (i < stars.length && +stars[i] < t + DAY) i++;
  points.push([t, i]);
}
const total = stars.length;

// ---- render ----------------------------------------------------------------

const THEMES = {
  light: { ink: "#1f2328", muted: "#59636e", grid: "#d1d9e0", line: "#2a78d6", ring: "#ffffff" },
  dark: { ink: "#f0f6fc", muted: "#9198a1", grid: "#3d444d", line: "#3987e5", ring: "#0d1117" },
};

const W = 880, H = 200;
const M = { top: 52, right: 20, bottom: 26, left: 36 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

function niceMax(v) {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
}

const yMax = niceMax(total);
const t0 = points[0][0], t1 = points.at(-1)[0];
const x = (t) => M.left + (t1 === t0 ? PW : ((t - t0) / (t1 - t0)) * PW);
const y = (v) => M.top + PH - (v / yMax) * PH;
const r = (n) => Math.round(n * 10) / 10;

// Drop runs of unchanged days so the path stays small: keep only the points
// where the count changes, plus the day before each change, plus the ends.
const kept = points.filter(
  (p, k) => k === 0 || k === points.length - 1 || p[1] !== points[k - 1][1] || p[1] !== points[k + 1][1],
);
const linePath = kept.map((p, k) => `${k ? "L" : "M"}${r(x(p[0]))},${r(y(p[1]))}`).join("");
const areaPath = `${linePath}L${r(x(t1))},${r(y(0))}L${r(x(t0))},${r(y(0))}Z`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthTicks() {
  const ticks = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (+d <= t1) {
    ticks.push(+d);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const step = Math.ceil(ticks.length / 6) || 1;
  const crossesYear = new Date(t0).getUTCFullYear() !== new Date(t1).getUTCFullYear();
  return ticks
    .filter((_, k) => k % step === 0)
    .map((t) => {
      const d = new Date(t);
      const label = MONTHS[d.getUTCMonth()];
      return [t, crossesYear ? `${label} ’${String(d.getUTCFullYear()).slice(2)}` : label];
    });
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (n) => n.toLocaleString("en-US");
const repoList = repos.map((r) => r.name).join(" · ");
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif`;

function render(c) {
  const yTicks = [0, yMax / 2, yMax];
  const endX = r(x(t1)), endY = r(y(total));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${fmt(total)} GitHub stars across ${ORG}">
<title>${fmt(total)} GitHub stars across ${ORG}</title>
<style>text{font-family:${FONT}}</style>
<text x="${M.left}" y="22" font-size="14" font-weight="600" fill="${c.ink}">Stars across ${ORG}</text>
<text x="${M.left}" y="40" font-size="12" fill="${c.muted}">${esc(repoList)}</text>
<text x="${W - M.right}" y="26" font-size="24" font-weight="600" fill="${c.ink}" text-anchor="end">★ ${fmt(total)}</text>
${yTicks
  .map(
    (v) => `<line x1="${M.left}" x2="${W - M.right}" y1="${r(y(v))}" y2="${r(y(v))}" stroke="${c.grid}" stroke-width="1"${v ? ` stroke-dasharray="2 4"` : ""}/>
<text x="${M.left - 8}" y="${r(y(v)) + 4}" font-size="11" fill="${c.muted}" text-anchor="end">${fmt(v)}</text>`,
  )
  .join("\n")}
${monthTicks()
  .map(([t, label]) => `<text x="${r(x(t))}" y="${H - 8}" font-size="11" fill="${c.muted}" text-anchor="middle">${label}</text>`)
  .join("\n")}
<path d="${areaPath}" fill="${c.line}" fill-opacity="0.12"/>
<path d="${linePath}" fill="none" stroke="${c.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${endX}" cy="${endY}" r="4" fill="${c.line}" stroke="${c.ring}" stroke-width="2"/>
</svg>
`;
}

writeFileSync(new URL("stars.svg", OUT), render(THEMES.light));
writeFileSync(new URL("stars-dark.svg", OUT), render(THEMES.dark));
console.log(`${total} stars across ${repos.length} repo(s): ${repoList}`);

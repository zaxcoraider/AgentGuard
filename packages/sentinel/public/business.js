// Business section: Sentinel's live books from its own status endpoint (not from the chain,
// unlike the rest of this page), plus a what-if calculator. Separate file so the chain-only
// code in agentguard.js stays as it is.
const NEAR_USD = 3.478; // 2026-11-07
const MARKET_JOB_USD = 0.3 * 0.95; // $0.30 a job, minus the market's 5% fee
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

let price = 0.01; // NEAR per check
let fixed = 0.288; // NEAR per day, replaced by the measured figure

function calc() {
  const agents = Number($("c-agents").value);
  const pays = Number($("c-pays").value);
  $("c-agents-out").textContent = agents;
  $("c-pays-out").textContent = pays;
  const revenue = agents * pays * price;
  const net = revenue - fixed;
  const sign = net >= 0 ? "+" : "−";
  $("c-out").innerHTML =
    `${fmt(agents * pays, 0)} ${agents * pays === 1 ? "check a day earns" : "checks a day earn"} <strong>${fmt(revenue)} NEAR</strong> (about $${fmt(revenue * NEAR_USD)}). ` +
    `After the fixed cost: <strong class="${net >= 0 ? "biz-pos" : "biz-neg"}">${sign}${fmt(Math.abs(net))} NEAR a day</strong>.`;
}

async function books() {
  try {
    const r = await fetch("/api/status");
    if (!r.ok) throw new Error(String(r.status));
    const b = (await r.json()).business;
    const k = b.books;
    price = Number(b.price_near) || price;
    fixed = Number(k.cost_per_day_near) || fixed;
    $("b-price").textContent = `${b.price_near} NEAR`;
    $("b-fixed").textContent = `${fmt(fixed, 3)} NEAR a day`;
    const jobs = Math.ceil((fixed * NEAR_USD) / MARKET_JOB_USD);
    $("b-even").textContent = String(k.break_even_checks_per_day ?? "—");
    $("b-even-note").textContent = `checks a day, or about ${jobs} Agent Market jobs a day`;
    $("b-earned").textContent = `${fmt(Number(k.revenue_near), 2)} NEAR`;
    $("b-spent").textContent = `${fmt(Number(k.costs_near), 2)} NEAR`;
    const net = Number(k.net_near);
    $("b-net").textContent = `${net < 0 ? "−" : "+"}${fmt(Math.abs(net))} NEAR`;
    $("b-net").className = net < 0 ? "biz-neg" : "biz-pos";
    $("b-days").textContent = `${fmt(Number(k.days_alive), 1)} days`;
    $("b-jobs").textContent = String(b.agent_market?.delivered ?? 0);
  } catch {
    for (const id of ["b-fixed", "b-even", "b-earned", "b-spent", "b-net", "b-days", "b-jobs"]) $(id).textContent = "Unavailable";
  }
  calc();
}

$("c-agents").addEventListener("input", calc);
$("c-pays").addEventListener("input", calc);
calc();
books();

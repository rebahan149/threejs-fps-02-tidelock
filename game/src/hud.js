// hud.js — everything drawn over the 3D view: the top bar (timer, score, round), health
// and armour, ammunition and money, the buy menu, killfeed, the team radio log, banners,
// the plant/defuse progress bar, the Tab scoreboard, the minimap, and the scope, flash
// and damage overlays. It reads G and the event stream; it never changes the simulation.

import { G, PHASE, weaponOf } from './state.js';
import { BOUNDS, colliders, SITES } from './world.js';
import { intent } from './input.js';

const $ = (id) => document.getElementById(id);
const els = {};
let bannerUntil = 0;
let flashUntil = 0;
let flashStrength = 0;
let lastHp = -1;
let feedCount = 0;

export const BUY_ITEMS = [
  { key: '1', id: 'longline', label: 'Longline Rifle' },
  { key: '2', id: 'harpoon', label: 'Harpoon DMR' },
  { key: '3', id: 'squall', label: 'Squall SMG' },
  { key: '4', id: 'breaker', label: 'Breaker Scattergun' },
  { key: '5', id: 'vest', label: 'Kevlar Vest' },
  { key: '6', id: 'helm', label: 'Vest + Helmet' },
  { key: '7', id: 'frag', label: 'Frag Charge' },
  { key: '8', id: 'smoke', label: 'Smoke Canister' },
  { key: '9', id: 'flash', label: 'Flash Flare' },
  { key: '0', id: 'kit', label: 'Defuse Kit' },
];

export function initHud() {
  for (const id of ['timer', 'scoreBrk', 'scoreWrd', 'roundLabel', 'phaseLabel', 'hpBar', 'hpText', 'armText',
    'ammoMag', 'ammoRes', 'gunName', 'money', 'killfeed', 'radio', 'banner', 'subbanner', 'channelWrap',
    'channelLabel', 'channelBar', 'buymenu', 'buygrid', 'scoreboard', 'minimap', 'vignette', 'flashveil',
    'scopeveil', 'hitmarker', 'hint', 'teamBrk', 'teamWrd', 'aliveBrk', 'aliveWrd', 'chargeState']) {
    els[id] = $(id);
  }
  const grid = els.buygrid;
  for (const item of BUY_ITEMS) {
    const d = document.createElement('div');
    d.className = 'buyitem';
    d.id = `buy-${item.id}`;
    d.innerHTML = `<span class="bk">${item.key}</span><span class="bl">${item.label}</span><span class="bp"></span>`;
    grid.appendChild(d);
  }
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function showBanner(text, sub = '', seconds = 2.6) {
  els.banner.textContent = text;
  els.subbanner.textContent = sub;
  els.banner.style.opacity = 1;
  els.subbanner.style.opacity = 1;
  bannerUntil = performance.now() / 1000 + seconds;
}

function addFeed(html, cls, parent, cap) {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent.appendChild(d);
  while (parent.children.length > cap) parent.removeChild(parent.firstChild);
  setTimeout(() => { d.style.opacity = 0; }, 4600);
  setTimeout(() => { d.remove(); }, 5400);
}

// HUD-facing events: kills for the feed, radio calls, round news for banners.
export function consumeHudEvents(events) {
  const p = G.player;
  for (const e of events) {
    switch (e.kind) {
      case 'kill': {
        const a = e.attacker ? e.attacker.name : 'The harbour';
        addFeed(`<b class="${e.attacker?.team === 'BRK' ? 'fb' : 'fw'}">${a}</b> ▸ <b>${e.victim.name}</b>${e.head ? ' ⌖' : ''}`, 'feedline', els.killfeed, 5);
        break;
      }
      case 'radio':
        if (p && (e.team === p.team || e.team === 'ALL')) {
          addFeed(`<span class="rname">${e.who}:</span> ${e.text}`, 'radioline', els.radio, 6);
        }
        break;
      case 'planted':
        showBanner(`CHARGE PLANTED — SITE ${e.site}`, p?.team === 'WRD' ? 'Retake and defuse' : 'Hold the site', 3);
        break;
      case 'chargedrop':
        if (p?.team === 'BRK') showBanner('CHARGE DROPPED', 'Recover it', 1.6);
        break;
      case 'chargepickup':
        if (p) showBanner(e.byPlayer ? 'YOU HAVE THE CHARGE' : 'CHARGE RECOVERED', e.byPlayer ? 'Plant at a site' : '', 1.6);
        break;
      case 'blinded':
        flashStrength = Math.max(flashStrength, e.strength);
        flashUntil = performance.now() / 1000 + e.dur;
        break;
      case 'hitmark':
        els.hitmarker.style.opacity = 1;
        setTimeout(() => { els.hitmarker.style.opacity = 0; }, 70);
        break;
      default: break;
    }
  }
}

export function updateHud() {
  const p = G.player;
  if (!p) return;
  const now = performance.now() / 1000;

  // Top bar.
  els.timer.textContent = G.phase === PHASE.BUY ? fmtTime(G.phaseT) : G.phase === PHASE.PLANTED ? fmtTime(Math.max(0, G.charge.plantAt + 35 - G.time)) : fmtTime(G.phaseT);
  els.timer.style.color = G.phase === PHASE.PLANTED ? '#ff8a7a' : '';
  els.scoreBrk.textContent = G.score.BRK;
  els.scoreWrd.textContent = G.score.WRD;
  els.roundLabel.textContent = `ROUND ${G.round} / 12`;
  els.phaseLabel.textContent =
    G.phase === PHASE.BUY ? 'BUY PHASE' :
    G.phase === PHASE.PLANTED ? `CHARGE LIVE — SITE ${G.charge.site}` :
    G.phase === PHASE.POST ? 'ROUND OVER' :
    G.phase === PHASE.OVER ? 'MATCH OVER' : 'LIVE';
  const alive = (t) => G.actors.filter((a) => a.team === t && a.alive).length;
  els.aliveBrk.textContent = '●'.repeat(alive('BRK')) + '○'.repeat(5 - alive('BRK'));
  els.aliveWrd.textContent = '●'.repeat(alive('WRD')) + '○'.repeat(5 - alive('WRD'));
  els.chargeState.textContent =
    G.charge.state === 'planted' ? `⬢ SITE ${G.charge.site}` :
    G.charge.state === 'dropped' ? '⬢ DROPPED' : p.hasCharge ? '⬢ YOU CARRY IT' : '⬢ IN PLAY';

  // Health and armour.
  if (p.hp !== lastHp) {
    lastHp = p.hp;
    els.hpBar.style.width = `${p.hp}%`;
    els.hpBar.style.background = p.hp > 50 ? '#7dd87d' : p.hp > 25 ? '#e8c85a' : '#e05a4e';
    els.hpText.textContent = Math.ceil(p.hp);
  }
  els.armText.textContent = p.armour === 2 ? '🛡 VEST + HELMET' : p.armour === 1 ? '🛡 VEST' : '';
  els.vignette.style.opacity = p.alive && p.hp < 55 ? (0.65 - p.hp / 100) : 0;

  // Ammunition, gun and money.
  const w = weaponOf(p);
  if (w) {
    els.ammoMag.textContent = G.time < p.reloadingUntil ? '——' : w.mag;
    els.ammoRes.textContent = `/ ${w.reserve}`;
    els.gunName.textContent = w.def.name + (p.primary && p.slot === 'secondary' ? '' : '');
  }
  els.money.textContent = `$${p.money}`;
  els.money.style.color = p.money < 200 ? '#e05a4e' : '';

  // Flash veil decays in real time.
  const fLeft = flashUntil - now;
  els.flashveil.style.opacity = fLeft > 0 ? Math.min(1, flashStrength * Math.min(1, fLeft / 0.5 + 0.25)) : 0;
  if (fLeft <= 0) flashStrength = 0;

  // Scope veil.
  els.scopeveil.style.opacity = p.scoped ? 1 : 0;

  // Banner fade.
  if (now > bannerUntil) {
    els.banner.style.opacity = 0;
    els.subbanner.style.opacity = 0;
  }

  // Context hint.
  let hint = '';
  if (G.phase === PHASE.BUY && p.alive) hint = 'B — buy menu · numbers buy';
  else if (p.hasCharge && G.phase === PHASE.LIVE) {
    const inA = Math.hypot(p.x - SITES.A.x, p.z - SITES.A.z) < SITES.A.r;
    const inB = Math.hypot(p.x - SITES.B.x, p.z - SITES.B.z) < SITES.B.r;
    hint = inA || inB ? 'HOLD E — plant the charge' : 'Carry the charge to site A or B';
  } else if (G.charge.state === 'planted' && p.team === 'WRD' && Math.hypot(p.x - G.charge.x, p.z - G.charge.z) < 2.2) {
    hint = 'HOLD E — defuse the charge';
  } else if (!p.alive) hint = 'You are down — watching your team';
  els.hint.textContent = hint;

  // Channel progress.
  if (G.channel && G.channel.actor === p) {
    els.channelWrap.style.opacity = 1;
    els.channelLabel.textContent = G.channel.kind === 'plant' ? 'PLANTING…' : 'DEFUSING…';
    els.channelBar.style.width = `${Math.min(100, (G.channel.t / G.channel.need) * 100)}%`;
  } else els.channelWrap.style.opacity = 0;

  // Buy menu.
  const showBuy = G.phase === PHASE.BUY && p.alive;
  els.buymenu.style.display = showBuy ? 'block' : 'none';
  if (showBuy) {
    for (const item of BUY_ITEMS) {
      const el = document.getElementById(`buy-${item.id}`);
      if (!el) continue;
      const price = item.id === 'vest' || item.id === 'helm' || item.id === 'frag' || item.id === 'smoke' || item.id === 'flash' || item.id === 'kit'
        ? { vest: 650, helm: 1000, frag: 300, smoke: 300, flash: 200, kit: 200 }[item.id]
        : { longline: 2700, harpoon: 3100, squall: 1250, breaker: 1100 }[item.id];
      el.querySelector('.bp').textContent = `$${price}`;
      el.classList.toggle('afford', p.money >= price);
      el.classList.toggle('owned', ownsItem(p, item.id));
    }
  }

  // Scoreboard.
  const showBoard = intent.scoreboard || G.phase === PHASE.OVER;
  els.scoreboard.style.display = showBoard ? 'block' : 'none';
  if (showBoard) renderBoard();

  drawMinimap();
}

function ownsItem(p, id) {
  switch (id) {
    case 'longline': return p.primary?.def.id === 'longline';
    case 'harpoon': return p.primary?.def.id === 'harpoon';
    case 'squall': return p.primary?.def.id === 'squall';
    case 'breaker': return p.primary?.def.id === 'breaker';
    case 'vest': return p.armour >= 1;
    case 'helm': return p.armour >= 2;
    case 'frag': return p.frag > 0;
    case 'smoke': return p.smoke > 0;
    case 'flash': return p.flash > 0;
    case 'kit': return p.defuseKit;
    default: return false;
  }
}

let boardCache = '';
function renderBoard() {
  const rows = [...G.actors].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const html = rows.map((a) =>
    `<tr class="${a.team === 'BRK' ? 'rb' : 'rw'}${a.isPlayer ? ' me' : ''}"><td>${a.name}${a.alive ? '' : ' †'}</td><td>${a.team === 'BRK' ? 'Breakers' : 'Wardens'}</td><td>${a.kills}</td><td>${a.deaths}</td><td>$${a.money}</td></tr>`,
  ).join('');
  if (html !== boardCache) {
    boardCache = html;
    els.scoreboard.innerHTML = `<h3>TIDELOCK — ROUND ${G.round} · BREAKERS ${G.score.BRK} — ${G.score.WRD} WARDENS</h3><table><tr><th>Player</th><th>Team</th><th>K</th><th>D</th><th>Money</th></tr>${html}</table>`;
  }
}

// ---- Minimap ----------------------------------------------------------------

const mm = { ctx: null, w: 216, h: 144 };
function drawMinimap() {
  if (!mm.ctx) {
    const c = els.minimap;
    if (!c) return;
    mm.ctx = c.getContext('2d');
  }
  const g = mm.ctx;
  const X = (x) => ((x - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * mm.w;
  const Z = (z) => ((z - BOUNDS.minZ) / (BOUNDS.maxZ - BOUNDS.minZ)) * mm.h;
  g.fillStyle = '#12242c';
  g.fillRect(0, 0, mm.w, mm.h);
  g.fillStyle = '#14586b';
  g.fillRect(X(-3), 0, X(3) - X(-3), mm.h);
  g.fillStyle = 'rgba(200,205,210,0.28)';
  for (const c of colliders) {
    if (c.h < 1.0) continue;
    g.fillRect(X(c.x0), Z(c.z0), Math.max(1.5, X(c.x1) - X(c.x0)), Math.max(1.5, Z(c.z1) - Z(c.z0)));
  }
  for (const s of [SITES.A, SITES.B]) {
    g.strokeStyle = s.id === 'A' ? '#ffb347' : '#6ee7c8';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(X(s.x), Z(s.z), s.r * 3, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = s.id === 'A' ? '#ffb347' : '#6ee7c8';
    g.font = 'bold 10px sans-serif';
    g.fillText(s.id, X(s.x) - 3, Z(s.z) + 3);
  }
  const p = G.player;
  // Enemies show only while a teammate's brain can see them.
  const seenNow = new Set();
  for (const a of G.actors) {
    if (a.alive && a.team === p.team && a.brain?.seen) seenNow.add(a.brain.seen);
  }
  for (const a of G.actors) {
    if (!a.alive) continue;
    if (a === p) continue;
    if (a.team === p.team) {
      g.fillStyle = '#8fd0ff';
    } else if (seenNow.has(a)) {
      g.fillStyle = '#ff6a5e';
    } else continue;
    g.beginPath();
    g.arc(X(a.x), Z(a.z), 2.6, 0, Math.PI * 2);
    g.fill();
  }
  // The charge.
  if (G.charge.state !== 'carried' || G.charge.carrier === p) {
    g.fillStyle = '#ff5347';
    const cx = G.charge.state === 'carried' ? p.x : G.charge.x;
    const cz = G.charge.state === 'carried' ? p.z : G.charge.z;
    g.fillRect(X(cx) - 2.5, Z(cz) - 2.5, 5, 5);
  }
  // The player as a heading arrow.
  g.save();
  g.translate(X(p.x), Z(p.z));
  g.rotate(p.yaw);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(0, -5);
  g.lineTo(3.4, 4);
  g.lineTo(-3.4, 4);
  g.closePath();
  g.fill();
  g.restore();
}
